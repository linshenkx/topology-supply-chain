import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, factories, inventoryBatches, inventoryReservations, inventoryTransfers, purchasePlanItems, purchasePlans, warehouses } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { retiredPlatformRoute } from "../../lib/retired-writer";

type Blockers = { inventory: number; reservations: number; transfers: number; unfinishedBusiness: number };

async function warehouseData() {
  const db = getDb();
  const [warehouseRows, factoryRows, batches, reservations, transfers, planItems, plans] = await Promise.all([
    db.select().from(warehouses).orderBy(desc(warehouses.updatedAt)).limit(500),
    db.select().from(factories).limit(500),
    db.select().from(inventoryBatches).limit(5000),
    db.select().from(inventoryReservations).where(eq(inventoryReservations.status, "active")).limit(5000),
    db.select().from(inventoryTransfers).limit(5000),
    db.select().from(purchasePlanItems).limit(5000),
    db.select().from(purchasePlans).limit(2000),
  ]);
  const batchWarehouse = new Map(batches.map(row => [row.id, row.warehouseId]));
  const openPlans = new Set(plans.filter(row => !["ordered_complete", "superseded"].includes(row.status)).map(row => row.id));
  return {
    factories: factoryRows,
    warehouses: warehouseRows.map(row => {
      const blockers: Blockers = {
        inventory: batches.filter(batch => batch.warehouseId === row.id).reduce((sum, batch) => sum + batch.availableQuantity + batch.lockedQuantity + batch.defectiveQuantity + batch.pendingInspectionQuantity + batch.quarantineQuantity, 0),
        reservations: reservations.filter(item => batchWarehouse.get(item.batchId) === row.id).reduce((sum, item) => sum + item.reservedQuantity, 0),
        transfers: transfers.filter(item => !["received", "rejected"].includes(item.status) && (item.fromWarehouseId === row.id || item.toWarehouseId === row.id)).length,
        unfinishedBusiness: planItems.filter(item => item.warehouseId === row.id && openPlans.has(item.purchasePlanId)).length,
      };
      const merged = row.status.startsWith("merged:");
      return { ...row, status: merged ? "merged" : row.status, mergedIntoWarehouseId: merged ? Number(row.status.slice(7)) : null, blockers };
    }),
  };
}

export async function GET() {
  return retiredPlatformRoute("/api/v1/warehouses");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/warehouses");
  try {
    const access = await requireAccess(request); requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb(); const now = new Date().toISOString();
    if (action === "create") {
      const code = String(body.code || "").trim().toUpperCase(); const name = String(body.name || "").trim();
      const type = String(body.type || "") as "factory" | "company" | "other"; const factoryId = body.factoryId ? Number(body.factoryId) : null;
      if (!code || !name || !["factory", "company", "other"].includes(type)) return Response.json({ error: "仓库编码、名称和类型均为必填项。" }, { status: 400 });
      if (type === "factory" && !factoryId) return Response.json({ error: "组装工厂仓必须选择所属工厂。" }, { status: 400 });
      if ((await db.select().from(warehouses).where(eq(warehouses.code, code)).limit(1))[0]) return Response.json({ error: "仓库编码已存在。" }, { status: 409 });
      const warehouse = await insertOne<typeof warehouses.$inferSelect>(db.insert(warehouses).values({ code, name, type, factoryId, address: String(body.address || "").trim() }), id => db.select().from(warehouses).where(eq(warehouses.id, id)).limit(1));
      await writeAudit(access, { action: "create", module: "warehouse_master", entityType: "warehouse", entityId: warehouse.id, businessNo: code, after: warehouse, request });
      return Response.json({ warehouse }, { status: 201 });
    }
    const id = Number(body.id); const [warehouse] = await db.select().from(warehouses).where(eq(warehouses.id, id)).limit(1);
    if (!warehouse) return Response.json({ error: "仓库不存在。" }, { status: 404 });
    if (action === "request_merge") {
      const targetId = Number(body.targetId); const reason = String(body.reason || "").trim();
      if (!targetId || targetId === id || !reason) return Response.json({ error: "请选择不同的目标仓库并填写合并原因。" }, { status: 400 });
      const [target] = await db.select().from(warehouses).where(eq(warehouses.id, targetId)).limit(1);
      if (warehouse.status !== "active" || target?.status !== "active") return Response.json({ error: "源仓库和目标仓库都必须处于启用状态。" }, { status: 409 });
      const approval = await insertOne<typeof approvalRequests.$inferSelect>(db.insert(approvalRequests).values({ requestNo: `AP-WHM-${Date.now()}`, workflowType: "warehouse_merge", entityType: "warehouse", entityId: id, summary: `仓库合并：${warehouse.name} → ${target.name}`, payloadJson: JSON.stringify({ sourceId: id, targetId, reason }), requestedBy: access.userId }), approvalId => db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).limit(1));
      await writeAudit(access, { action: "submit_approval", module: "warehouse_master", entityType: "warehouse_merge", entityId: approval.id, businessNo: approval.requestNo, after: { sourceId: id, targetId, reason }, request });
      return Response.json({ approval, approvalRequired: true }, { status: 201 });
    }
    if (action === "deactivate") {
      if (warehouse.status !== "active") return Response.json({ error: "只有启用中的仓库可以停用。" }, { status: 409 });
      const current = (await warehouseData()).warehouses.find(row => row.id === id);
      const blockers = current?.blockers;
      if (!blockers || Object.values(blockers).some(value => value > 0)) return Response.json({ error: "仓库仍有库存、预留、在途调拨或未完成业务，必须先处理完毕。", blockers }, { status: 409 });
      await db.update(warehouses).set({ status: "inactive", updatedAt: now }).where(eq(warehouses.id, id));
      await writeAudit(access, { action: "deactivate", module: "warehouse_master", entityType: "warehouse", entityId: id, businessNo: warehouse.code, before: warehouse, request });
      return Response.json({ success: true });
    }
    return Response.json({ error: "不支持的仓库操作。" }, { status: 400 });
  } catch (error) { return accessErrorResponse(error); }
}
