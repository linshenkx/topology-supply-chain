import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  inventoryBatches,
  inventoryReservations,
  inventoryTransfers,
  warehouses,
} from "../../../db/schema";
import { executeAffected, insertOne } from "../../../db/insert-one";
import {
  accessErrorResponse,
  isInternal,
  requireAccess,
  requireRole,
} from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { findInventoryFreeze } from "../../lib/inventory-freeze";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    if (access.localPreview) return Response.json({ batches: [], preview: true });

    const url = new URL(request.url);
    const warehouseId = Number(url.searchParams.get("warehouseId") ?? 0);
    const sku = url.searchParams.get("sku")?.trim();
    const db = getDb();

    const permittedWarehouses = isInternal(access)
      ? await db.select({ id: warehouses.id }).from(warehouses)
      : await db
          .select({ id: warehouses.id })
          .from(warehouses)
          .where(eq(warehouses.factoryId, access.factoryId ?? -1));
    const warehouseIds = permittedWarehouses.map((row) => row.id);
    if (!warehouseIds.length) return Response.json({ batches: [], warehouses: [], reservations: [], transfers: [] });
    if (warehouseId && !warehouseIds.includes(warehouseId)) {
      return Response.json({ error: "无权查看该仓库库存。" }, { status: 403 });
    }

    const filters = [
      inArray(inventoryBatches.warehouseId, warehouseId ? [warehouseId] : warehouseIds),
    ];
    if (sku) filters.push(eq(inventoryBatches.sku, sku));
    const batches = await db
      .select()
      .from(inventoryBatches)
      .where(and(...filters))
      // FEFO：有到期日的批次优先按到期日推荐，无到期日的批次排在后面。
      .orderBy(asc(inventoryBatches.expiryDate), desc(inventoryBatches.inboundDate))
      .limit(500);

    const warehouseRows = await db.select().from(warehouses).where(inArray(warehouses.id, warehouseIds));
    const batchIds = batches.map(row => row.id);
    const reservations = batchIds.length
      ? await db.select().from(inventoryReservations).where(and(inArray(inventoryReservations.batchId, batchIds), eq(inventoryReservations.status, "active"))).orderBy(desc(inventoryReservations.createdAt)).limit(200)
      : [];
    const transfers = await db.select().from(inventoryTransfers)
      .where(or(
        inArray(inventoryTransfers.fromWarehouseId, warehouseIds),
        inArray(inventoryTransfers.toWarehouseId, warehouseIds),
      ))
      .orderBy(desc(inventoryTransfers.createdAt)).limit(100);

    if (url.searchParams.get("sensitive") === "1") {
      await writeAudit(access, {
        action: "view",
        module: "inventory",
        entityType: "inventory_batch",
        entityId: warehouseId || "all",
        sensitiveView: true,
        request,
      });
    }
    return Response.json({ batches, warehouses: warehouseRows, reservations, transfers });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = (await request.json()) as {
      batchId?: number;
      entityType?: "purchase_order" | "production_order" | "shipment_plan" | "historical";
      entityId?: number;
      requestedQuantity?: number;
      priority?: number;
    };
    const requestedQuantity = Math.trunc(Number(body.requestedQuantity));
    if (!body.batchId || !body.entityType || requestedQuantity <= 0) {
      return Response.json({ error: "批次、预留业务类型和预留数量不能为空。" }, { status: 400 });
    }
    if (body.entityType !== "historical" && !body.entityId) {
      return Response.json({ error: "非历史预留必须关联业务单据。" }, { status: 400 });
    }
    if (access.localPreview) {
      return Response.json(
        {
          reservation: {
            id: 0,
            batchId: body.batchId,
            requestedQuantity,
            reservedQuantity: requestedQuantity,
            shortageQuantity: 0,
          },
          preview: true,
        },
        { status: 201 },
      );
    }

    const db = getDb();
    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, body.batchId))
      .limit(1);
    if (!batch) return Response.json({ error: "库存批次不存在。" }, { status: 404 });
    if (!isInternal(access)) {
      const [warehouse] = await db
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, batch.warehouseId))
        .limit(1);
      if (!warehouse || warehouse.factoryId !== access.factoryId) {
        return Response.json({ error: "无权操作该仓库库存。" }, { status: 403 });
      }
    }
    const freeze = await findInventoryFreeze({ warehouseId: batch.warehouseId, sku: batch.sku, batchId: batch.id });
    if (freeze) {
      return Response.json({ error: `盘点 ${freeze.stocktakeNo} 期间禁止预留或变更库存。` }, { status: 409 });
    }
    if (batch.expiryStatus === "expired_frozen" || batch.quarantineQuantity > 0) {
      return Response.json({ error: "过期冻结或隔离批次禁止预留。" }, { status: 409 });
    }

    // 条件更新是最终防线：并发请求也无法把可用库存扣成负数。
    const reservedQuantity = Math.min(requestedQuantity, Math.max(0, batch.availableQuantity));
    const shortageQuantity = Math.max(0, requestedQuantity - reservedQuantity);
    const updated = reservedQuantity === 0 ? 1 : await executeAffected(db
      .update(inventoryBatches)
      .set({
        availableQuantity: sql`${inventoryBatches.availableQuantity} - ${reservedQuantity}`,
        lockedQuantity: sql`${inventoryBatches.lockedQuantity} + ${reservedQuantity}`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(inventoryBatches.id, body.batchId),
          sql`${inventoryBatches.availableQuantity} >= ${reservedQuantity}`,
        ),
      ));
    if (!updated) {
      return Response.json(
        {
          error: "可用库存不足，系统禁止产生负库存。",
          availableQuantity: batch.availableQuantity,
          requestedQuantity,
          shortageQuantity: Math.max(0, requestedQuantity - batch.availableQuantity),
        },
        { status: 409 },
      );
    }

    const reservation = await insertOne<typeof inventoryReservations.$inferSelect>(
      db.insert(inventoryReservations).values({
        batchId: body.batchId,
        entityType: body.entityType,
        entityId: body.entityId,
        requestedQuantity,
        reservedQuantity,
        shortageQuantity,
        priority: body.priority ?? 0,
        createdBy: access.userId,
      }),
      id => db.select().from(inventoryReservations).where(eq(inventoryReservations.id, id)).limit(1),
    );
    await writeAudit(access, {
      action: "reserve",
      module: "inventory",
      entityType: "inventory_reservation",
      entityId: reservation.id,
      after: reservation,
      request,
    });
    return Response.json({ reservation }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
