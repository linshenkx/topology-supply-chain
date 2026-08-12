import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  deliveryBatches,
  executionOrders,
  inventoryBatches,
  inventoryMovements,
  orderItems,
  productReturnDispositions,
  productReturnInspections,
  productReturns,
} from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { withDbTransaction } from "../../../db/transaction";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/returns");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/returns");
  try {
    const access = await requireAccess(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "receive") return receiveReturn(request, access, body);
    if (body.action === "inspect") return inspectReturn(request, access, body);
    if (body.action === "propose") return proposeDisposition(request, access, body);
    if (body.action === "review") return reviewDisposition(request, access, body);
    return Response.json({ error: "不支持的退货操作。" }, { status: 400 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

async function receiveReturn(request: Request, access: Awaited<ReturnType<typeof requireAccess>>, body: Record<string, unknown>) {
  requireRole(access, ["admin", "supply_chain"]);
  const sourceDeliveryBatchId = Number(body.sourceDeliveryBatchId);
  const warehouseId = Number(body.warehouseId);
  const quantity = Math.trunc(Number(body.quantity));
  const returnNo = String(body.returnNo ?? "").trim();
  if (!sourceDeliveryBatchId || !warehouseId || quantity <= 0 || !returnNo) {
    return Response.json({ error: "退货单号、原发货批次、退回仓库和数量不能为空。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ return: { id: 0, returnNo }, preview: true }, { status: 201 });
  const db = getDb();
  const [shipment] = await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, sourceDeliveryBatchId)).limit(1);
  if (!shipment) return Response.json({ error: "原发货批次不存在。" }, { status: 404 });
  const [execution] = await db.select().from(executionOrders).where(eq(executionOrders.id, shipment.executionOrderId)).limit(1);
  const [item] = execution
    ? await db.select().from(orderItems).where(eq(orderItems.id, execution.orderItemId)).limit(1)
    : [];
  if (!item) return Response.json({ error: "无法确认退货产品SKU。" }, { status: 409 });
  const batch = await insertOne<typeof inventoryBatches.$inferSelect>(db.insert(inventoryBatches).values({
    batchNo: `RETURN-${returnNo}`,
    warehouseId,
    sku: item.sku,
    inboundDate: new Date().toISOString().slice(0, 10),
    quarantineQuantity: quantity,
    ownership: "company",
    expiryStatus: "normal",
  }), id => db.select().from(inventoryBatches).where(eq(inventoryBatches.id, id)).limit(1));
  const productReturn = await insertOne<typeof productReturns.$inferSelect>(db.insert(productReturns).values({
    returnNo,
    sourceDeliveryBatchId,
    warehouseId,
    sku: item.sku,
    quantity,
    batchId: batch.id,
    status: "quarantined",
  }), id => db.select().from(productReturns).where(eq(productReturns.id, id)).limit(1));
  await writeAudit(access, { action: "receive", module: "returns", entityType: "product_return", entityId: productReturn.id, businessNo: returnNo, after: productReturn, request });
  return Response.json({ return: productReturn, frozenBatch: batch }, { status: 201 });
}

async function inspectReturn(request: Request, access: Awaited<ReturnType<typeof requireAccess>>, body: Record<string, unknown>) {
  requireRole(access, ["admin", "company_qc", "supplier_qc"]);
  const productReturnId = Number(body.productReturnId);
  const inspectedQuantity = Math.trunc(Number(body.inspectedQuantity));
  const passedQuantity = Math.trunc(Number(body.passedQuantity));
  const failedQuantity = Math.trunc(Number(body.failedQuantity));
  const evidenceFileKey = String(body.evidenceFileKey ?? "").trim();
  const defectReason = String(body.defectReason ?? "").trim();
  if (!productReturnId || inspectedQuantity <= 0 || passedQuantity < 0 || failedQuantity < 0 || !evidenceFileKey) {
    return Response.json({ error: "退货质检数量和现场凭证不能为空。" }, { status: 400 });
  }
  if (passedQuantity + failedQuantity !== inspectedQuantity) {
    return Response.json({ error: "合格数与不合格数之和必须等于检验数量。" }, { status: 400 });
  }
  if (failedQuantity && !defectReason) return Response.json({ error: "存在不合格品时必须填写不良原因。" }, { status: 400 });
  if (access.localPreview) return Response.json({ inspection: { id: 0 }, preview: true }, { status: 201 });
  const db = getDb();
  const [record] = await db.select().from(productReturns).where(eq(productReturns.id, productReturnId)).limit(1);
  if (!record || record.status !== "quarantined" || inspectedQuantity !== record.quantity) {
    return Response.json({ error: "退货单状态不正确，且退货质检必须覆盖全部退回数量。" }, { status: 409 });
  }
  if (!(await canAccessReturn(record, access))) return Response.json({ error: "无权质检该退货单。" }, { status: 403 });
  const inspection = await insertOne<typeof productReturnInspections.$inferSelect>(db.insert(productReturnInspections).values({
    productReturnId,
    inspectedQuantity,
    passedQuantity,
    failedQuantity,
    defectReason,
    evidenceFileKey,
    inspectedBy: access.userId,
  }), id => db.select().from(productReturnInspections).where(eq(productReturnInspections.id, id)).limit(1));
  await db.update(productReturns).set({ status: "pending_supply_chain", updatedAt: new Date().toISOString() }).where(eq(productReturns.id, productReturnId));
  await writeAudit(access, { action: "inspect", module: "returns", entityType: "product_return_inspection", entityId: inspection.id, after: inspection, request });
  return Response.json({ inspection }, { status: 201 });
}

async function proposeDisposition(request: Request, access: Awaited<ReturnType<typeof requireAccess>>, body: Record<string, unknown>) {
  requireRole(access, ["admin", "factory"]);
  const productReturnId = Number(body.productReturnId);
  const dispositions = Array.isArray(body.dispositions) ? body.dispositions as Array<{ type?: string; quantity?: number }> : [];
  if (!productReturnId || !dispositions.length) return Response.json({ error: "必须填写退货处理方案。" }, { status: 400 });
  if (dispositions.some((row) => !["restock", "rework", "scrap"].includes(row.type ?? "") || Math.trunc(Number(row.quantity)) < 0)) {
    return Response.json({ error: "处理方式或数量不合法。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ success: true, preview: true });
  const db = getDb();
  const [record] = await db.select().from(productReturns).where(eq(productReturns.id, productReturnId)).limit(1);
  if (!record) return Response.json({ error: "退货单不存在。" }, { status: 404 });
  if (!(await canAccessReturn(record, access))) return Response.json({ error: "无权处理该退货单。" }, { status: 403 });
  const total = dispositions.reduce((sum, row) => sum + Math.trunc(Number(row.quantity)), 0);
  if (total !== record.quantity) return Response.json({ error: "重新入库、返工和报废数量合计必须等于退货数量。" }, { status: 409 });
  for (const row of dispositions.filter((item) => Number(item.quantity) > 0)) {
    await db.insert(productReturnDispositions).values({
      productReturnId,
      type: row.type as "restock" | "rework" | "scrap",
      quantity: Math.trunc(Number(row.quantity)),
      proposedBy: access.userId,
    });
  }
  await writeAudit(access, { action: "propose", module: "returns", entityType: "product_return", entityId: productReturnId, after: { dispositions }, request });
  return Response.json({ success: true });
}

async function canAccessReturn(
  record: typeof productReturns.$inferSelect,
  access: Awaited<ReturnType<typeof requireAccess>>,
) {
  if (isInternal(access)) return true;
  const db = getDb();
  const [shipment] = await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, record.sourceDeliveryBatchId)).limit(1);
  if (!shipment) return false;
  const [execution] = await db.select().from(executionOrders).where(eq(executionOrders.id, shipment.executionOrderId)).limit(1);
  if (!execution) return false;
  if (access.factoryId && execution.factoryId === access.factoryId) return true;
  if (access.supplierId) {
    const [item] = await db.select({ supplierId: orderItems.supplierId }).from(orderItems).where(eq(orderItems.id, execution.orderItemId)).limit(1);
    return item?.supplierId === access.supplierId;
  }
  return false;
}

async function reviewDisposition(request: Request, access: Awaited<ReturnType<typeof requireAccess>>, body: Record<string, unknown>) {
  requireRole(access, ["admin", "supply_chain"]);
  const productReturnId = Number(body.productReturnId);
  const decision = String(body.decision);
  if (!productReturnId || !["approved", "rejected"].includes(decision)) return Response.json({ error: "退货单和审核结果不能为空。" }, { status: 400 });
  if (access.localPreview) return Response.json({ success: true, preview: true });
  const db = getDb();
  const [record] = await db.select().from(productReturns).where(eq(productReturns.id, productReturnId)).limit(1);
  if (!record?.batchId) return Response.json({ error: "退货单或冻结批次不存在。" }, { status: 404 });
  const dispositions = await db.select().from(productReturnDispositions).where(eq(productReturnDispositions.productReturnId, productReturnId));
  if (!dispositions.length) return Response.json({ error: "工厂尚未提交处理方案。" }, { status: 409 });
  if (dispositions.some((row) => row.proposedBy === access.userId)) return Response.json({ error: "处理方案发起人不能审核本人提交的事项。" }, { status: 409 });
  const now = new Date().toISOString();
  await withDbTransaction(db, async tx => {
    for (const disposition of dispositions) {
      await tx.update(productReturnDispositions).set({ status: decision as "approved" | "rejected", reviewedBy: access.userId, reviewedAt: now, updatedAt: now }).where(eq(productReturnDispositions.id, disposition.id));
    }
    if (decision === "approved") {
      const restock = dispositions.find((row) => row.type === "restock")?.quantity ?? 0;
      await tx.update(inventoryBatches).set({
        quarantineQuantity: sql`${inventoryBatches.quarantineQuantity} - ${record.quantity}`,
        availableQuantity: sql`${inventoryBatches.availableQuantity} + ${restock}`,
        defectiveQuantity: sql`${inventoryBatches.defectiveQuantity} + ${record.quantity - restock}`,
        updatedAt: now,
      }).where(eq(inventoryBatches.id, record.batchId!));
      if (restock) await tx.insert(inventoryMovements).values({
        warehouseId: record.warehouseId,
        sku: record.sku,
        type: "inbound",
        quantity: restock,
        createdBy: access.userId,
      });
    }
    await tx.update(productReturns).set({ status: decision === "approved" ? "restocked" : "inspection", reviewedBy: access.userId, reviewedAt: now, updatedAt: now }).where(eq(productReturns.id, productReturnId));
  });
  await writeAudit(access, { action: decision, module: "returns", entityType: "product_return", entityId: productReturnId, businessNo: record.returnNo, before: record, after: { dispositions }, request });
  return Response.json({ success: true });
}
