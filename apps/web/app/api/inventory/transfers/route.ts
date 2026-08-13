import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@database/index";
import { approvalRequests, inventoryBatches, inventoryMovements, inventoryTransfers, warehouses } from "@database/schema";
import { executeAffected, insertOne } from "@database/insert-one";
import { withDbTransaction } from "@database/transaction";
import { AccessError, accessErrorResponse, isInternal, requireAccess, requireRole } from "../../../lib/authz";
import { writeAudit } from "../../../lib/audit";
import { findInventoryFreeze } from "../../../lib/inventory-freeze";
import {
  INVENTORY_TRANSFER_TRANSITIONS,
  mutationAffectedExactlyOnce,
  planInventoryTransferDeductions,
} from "../../../lib/inventory-transfer-guard";
import { retiredPlatformRoute } from "../../../lib/retired-writer";

function transferNo() {
  return `TR${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}${Math.floor(Math.random() * 900 + 100)}`;
}

async function allowedWarehouseIds(access: Awaited<ReturnType<typeof requireAccess>>) {
  const db = getDb();
  const rows = isInternal(access)
    ? await db.select({ id: warehouses.id }).from(warehouses)
    : await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.factoryId, access.factoryId ?? -1));
  return rows.map(row => row.id);
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/inventory/transfers");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { fromWarehouseId?: number; toWarehouseId?: number; sku?: string; quantity?: number; reason?: string };
    const quantity = Math.trunc(Number(body.quantity));
    if (!body.fromWarehouseId || !body.toWarehouseId || body.fromWarehouseId === body.toWarehouseId || !body.sku?.trim() || quantity <= 0 || !body.reason?.trim()) {
      return Response.json({ error: "调出仓、调入仓、SKU、数量和原因均为必填项。" }, { status: 400 });
    }
    const permitted = await allowedWarehouseIds(access);
    if (!permitted.includes(body.fromWarehouseId)) return Response.json({ error: "无权从该仓库发起调拨。" }, { status: 403 });
    const db = getDb();
    const warehouseRows = await db.select().from(warehouses).where(inArray(warehouses.id, [body.fromWarehouseId, body.toWarehouseId]));
    if (warehouseRows.length !== 2) return Response.json({ error: "调出仓或调入仓不存在。" }, { status: 404 });
    if (warehouseRows.some(row => row.status !== "active")) return Response.json({ error: "已停用或已合并的仓库不能发起调拨。" }, { status: 409 });
    const no = transferNo();
    const transfer = await insertOne<typeof inventoryTransfers.$inferSelect>(db.insert(inventoryTransfers).values({
      transferNo: no, fromWarehouseId: body.fromWarehouseId, toWarehouseId: body.toWarehouseId,
      sku: body.sku.trim(), quantity, reason: body.reason.trim(), requestedBy: access.userId,
    }), id => db.select().from(inventoryTransfers).where(eq(inventoryTransfers.id, id)).limit(1));
    await db.insert(approvalRequests).values({
      requestNo: `APR-${no}`, workflowType: "warehouse_transfer", entityType: "inventory_transfer", entityId: transfer.id,
      summary: `仓库调拨 ${no}：${transfer.sku} × ${quantity}`,
      payloadJson: JSON.stringify({ fromWarehouseId: body.fromWarehouseId, toWarehouseId: body.toWarehouseId, sku: transfer.sku, quantity, reason: transfer.reason }),
      requestedBy: access.userId,
    });
    await writeAudit(access, { action: "create", module: "inventory", entityType: "inventory_transfer", entityId: transfer.id, after: transfer, request });
    return Response.json({ transfer }, { status: 201 });
  } catch (error) { return accessErrorResponse(error); }
}

export async function PATCH(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/inventory/transfers");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { id?: number; action?: "ship" | "receive" };
    if (!body.id || !body.action) return Response.json({ error: "调拨单和操作不能为空。" }, { status: 400 });
    const db = getDb();
    const [transfer] = await db.select().from(inventoryTransfers).where(eq(inventoryTransfers.id, body.id)).limit(1);
    if (!transfer) return Response.json({ error: "调拨单不存在。" }, { status: 404 });
    const permitted = await allowedWarehouseIds(access);
    const now = new Date().toISOString();
    if (body.action === "ship") {
      if (transfer.status !== "approved") return Response.json({ error: "调拨需先通过供应链审批。" }, { status: 409 });
      if (!permitted.includes(transfer.fromWarehouseId)) return Response.json({ error: "无权操作调出仓。" }, { status: 403 });
      const freeze = await findInventoryFreeze({ warehouseId: transfer.fromWarehouseId, sku: transfer.sku });
      if (freeze) return Response.json({ error: `盘点 ${freeze.stocktakeNo} 期间禁止调出库存。` }, { status: 409 });
      const batches = await db.select().from(inventoryBatches).where(and(
        eq(inventoryBatches.warehouseId, transfer.fromWarehouseId), eq(inventoryBatches.sku, transfer.sku),
        eq(inventoryBatches.ownership, "company"), gt(inventoryBatches.availableQuantity, 0),
        sql`${inventoryBatches.expiryStatus} <> 'expired_frozen'`,
        eq(inventoryBatches.quarantineQuantity, 0),
      )).orderBy(asc(inventoryBatches.expiryDate), asc(inventoryBatches.inboundDate));
      const deductionPlan = planInventoryTransferDeductions(batches, transfer.quantity);
      if (deductionPlan.remaining !== 0) return Response.json({ error: "可用库存不足，禁止负库存发出。" }, { status: 409 });
      await withDbTransaction(db, async tx => {
        const transition = INVENTORY_TRANSFER_TRANSITIONS.ship;
        const claimed = await executeAffected(tx.update(inventoryTransfers).set({
          status: transition.to,
          shippedAt: now,
          updatedAt: now,
        }).where(and(
          eq(inventoryTransfers.id, transfer.id),
          eq(inventoryTransfers.status, transition.from),
        )));
        if (!mutationAffectedExactlyOnce(claimed)) {
          throw new AccessError(409, "调拨单状态已发生变化，请刷新后重试。");
        }

        let remaining = transfer.quantity;
        for (const deduction of deductionPlan.deductions) {
          const updated = await executeAffected(tx.update(inventoryBatches).set({
            availableQuantity: sql`${inventoryBatches.availableQuantity} - ${deduction.quantity}`,
            updatedAt: now,
          }).where(and(
            eq(inventoryBatches.id, deduction.batchId),
            gte(inventoryBatches.availableQuantity, deduction.quantity),
          )));
          if (!mutationAffectedExactlyOnce(updated)) {
            throw new AccessError(409, "库存发生并发变化，请刷新后重新提交调拨。");
          }
          remaining -= deduction.quantity;
        }
        if (remaining !== 0) {
          throw new AccessError(409, "库存扣减未完整执行，请刷新后重新提交调拨。");
        }
        await tx.insert(inventoryMovements).values({ warehouseId: transfer.fromWarehouseId, sku: transfer.sku, type: "transfer_out", quantity: -transfer.quantity, createdBy: access.userId, occurredAt: now });
      });
    } else {
      if (transfer.status !== "shipped") return Response.json({ error: "只有已发出的调拨单才能确认收货。" }, { status: 409 });
      if (!isInternal(access) && !permitted.includes(transfer.toWarehouseId)) return Response.json({ error: "无权操作调入仓。" }, { status: 403 });
      const freeze = await findInventoryFreeze({ warehouseId: transfer.toWarehouseId, sku: transfer.sku });
      if (freeze) return Response.json({ error: `盘点 ${freeze.stocktakeNo} 期间禁止调入库存。` }, { status: 409 });
      await withDbTransaction(db, async tx => {
        const transition = INVENTORY_TRANSFER_TRANSITIONS.receive;
        const claimed = await executeAffected(tx.update(inventoryTransfers).set({
          status: transition.to,
          receivedAt: now,
          updatedAt: now,
        }).where(and(
          eq(inventoryTransfers.id, transfer.id),
          eq(inventoryTransfers.status, transition.from),
        )));
        if (!mutationAffectedExactlyOnce(claimed)) {
          throw new AccessError(409, "调拨单状态已发生变化，请刷新后重试。");
        }

        await tx.insert(inventoryBatches).values({ batchNo: `${transfer.transferNo}-IN`, warehouseId: transfer.toWarehouseId, sku: transfer.sku, inboundDate: now.slice(0, 10), availableQuantity: transfer.quantity, ownership: "company" });
        await tx.insert(inventoryMovements).values({ warehouseId: transfer.toWarehouseId, sku: transfer.sku, type: "transfer_in", quantity: transfer.quantity, createdBy: access.userId, occurredAt: now });
      });
    }
    await writeAudit(access, { action: body.action, module: "inventory", entityType: "inventory_transfer", entityId: transfer.id, request });
    return Response.json({ success: true });
  } catch (error) { return accessErrorResponse(error); }
}
