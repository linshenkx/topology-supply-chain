import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { insertOne } from "../../../db/insert-one";
import {
  approvalRequests, bomComponents, executionOrders, factories, orderItems, productBoms,
  productionMaterialLines, productionReports, purchaseOrders, skus,
} from "../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { assertProductionWarehouse, finalizeProductionInventory } from "../../lib/production-finalization";
import { retiredPlatformRoute } from "../../lib/retired-writer";

const now = () => new Date().toISOString();
const deviationBps = (actual: number, expected: number) => expected <= 0 ? (actual > 0 ? 10000 : 0) : Math.round(Math.abs(actual - expected) * 10000 / expected);

async function loadData(factoryId?: number | null) {
  const db = getDb();
  const [orders, items, purchaseRows, factoryRows, boms, components, lines, reports, skuRows] = await Promise.all([
    db.select().from(executionOrders).orderBy(desc(executionOrders.createdAt)).limit(200),
    db.select().from(orderItems), db.select().from(purchaseOrders), db.select().from(factories),
    db.select().from(productBoms), db.select().from(bomComponents), db.select().from(productionMaterialLines),
    db.select().from(productionReports), db.select().from(skus),
  ]);
  const visible = factoryId ? orders.filter(row => row.factoryId === factoryId) : orders;
  const usedItems = new Set(orders.map(row => row.orderItemId));
  return {
    orders: visible.map(order => ({
      ...order,
      item: items.find(row => row.id === order.orderItemId),
      purchaseOrder: purchaseRows.find(row => row.id === items.find(item => item.id === order.orderItemId)?.purchaseOrderId),
      factory: factoryRows.find(row => row.id === order.factoryId),
      bom: boms.find(row => row.id === order.bomId),
      materials: lines.filter(row => row.executionOrderId === order.id).map(line => ({ ...line, component: components.find(row => row.id === line.bomComponentId) })),
      reports: reports.filter(row => row.executionOrderId === order.id).sort((a, b) => b.id - a.id),
    })),
    options: {
      orderItems: items.filter(row => row.itemType === "finished" && !usedItems.has(row.id)).map(item => ({ ...item, purchaseOrder: purchaseRows.find(row => row.id === item.purchaseOrderId) })),
      factories: factoryId ? factoryRows.filter(row => row.id === factoryId) : factoryRows.filter(row => row.status === "active"),
      boms: boms.filter(row => row.approvalStatus === "approved" && row.active),
      skus: skuRows,
    },
  };
}

export async function GET() {
  return retiredPlatformRoute("/api/v1/production-orders");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/production-orders");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { orderItemId?: number; factoryId?: number; bomId?: number; plannedQuantity?: number; plannedStartDate?: string; plannedFinishDate?: string };
    const factoryId = access.factoryId ?? body.factoryId;
    if (!body.orderItemId || !factoryId || !body.bomId || !body.plannedQuantity || body.plannedQuantity <= 0 || !body.plannedStartDate || !body.plannedFinishDate) {
      return Response.json({ error: "采购明细、工厂、BOM、计划数量和计划日期均为必填项。" }, { status: 400 });
    }
    if (body.plannedStartDate > body.plannedFinishDate) return Response.json({ error: "计划完工日期不能早于计划开工日期。" }, { status: 400 });
    if (access.localPreview) return Response.json({ success: true, preview: true }, { status: 201 });
    const db = getDb();
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, body.orderItemId)).limit(1);
    const [bom] = await db.select().from(productBoms).where(eq(productBoms.id, body.bomId)).limit(1);
    if (!item || item.itemType !== "finished") return Response.json({ error: "只能为成品采购明细创建生产单。" }, { status: 400 });
    if (!bom || bom.approvalStatus !== "approved" || !bom.active || bom.finishedSku !== item.sku) return Response.json({ error: "请选择该成品已审批且有效的BOM版本。" }, { status: 400 });
    const [purchaseOrder] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, item.purchaseOrderId)).limit(1);
    if (!purchaseOrder?.orderDate) return Response.json({ error: "采购单缺少下单日期，无法确定应使用的 BOM 版本。" }, { status: 400 });
    if (purchaseOrder.orderDate < bom.effectiveFrom || (bom.effectiveTo && purchaseOrder.orderDate > bom.effectiveTo)) {
      return Response.json({ error: `BOM ${bom.version} 在采购单下单日 ${purchaseOrder.orderDate} 不在有效期内。` }, { status: 400 });
    }
    const duplicate = await db.select().from(executionOrders).where(eq(executionOrders.orderItemId, item.id)).limit(1);
    if (duplicate.length) return Response.json({ error: "该采购明细已经创建生产单。" }, { status: 409 });
    const stamp = Date.now().toString().slice(-8);
    const order = await insertOne<typeof executionOrders.$inferSelect>(db.insert(executionOrders).values({
      executionNo: `MO${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${stamp}`,
      orderItemId: item.id, factoryId, bomId: bom.id, plannedQuantity: body.plannedQuantity,
      status: "planned", dueDate: item.dueDate, plannedStartDate: body.plannedStartDate, plannedFinishDate: body.plannedFinishDate,
    }), id => db.select().from(executionOrders).where(eq(executionOrders.id, id)).limit(1));
    const components = await db.select().from(bomComponents).where(eq(bomComponents.bomId, bom.id));
    for (const component of components) await db.insert(productionMaterialLines).values({
      executionOrderId: order.id, bomComponentId: component.id,
      theoreticalQuantity: component.quantityPerFinished * body.plannedQuantity,
      reservedQuantity: component.quantityPerFinished * body.plannedQuantity,
    });
    await writeAudit(access, { action: "create", module: "production", entityType: "execution_order", entityId: order.id, businessNo: order.executionNo, after: order, request });
    return Response.json({ order }, { status: 201 });
  } catch (error) { return accessErrorResponse(error); }
}

export async function PATCH(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/production-orders");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { action?: "start" | "materials" | "complete"; id?: number; actualFinishedQuantity?: number; lines?: Array<{ id: number; issuedQuantity: number; consumedQuantity: number; lossQuantity: number }> };
    if (!body.id || !body.action) return Response.json({ error: "生产单和操作类型不能为空。" }, { status: 400 });
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb();
    const [order] = await db.select().from(executionOrders).where(eq(executionOrders.id, body.id)).limit(1);
    if (!order) return Response.json({ error: "生产单不存在。" }, { status: 404 });
    if (access.factoryId && order.factoryId !== access.factoryId) return Response.json({ error: "无权操作其他工厂的生产单。" }, { status: 403 });
    if (body.action === "start") {
      await db.update(executionOrders).set({ status: "in_production", actualStartAt: now(), updatedAt: now() }).where(eq(executionOrders.id, order.id));
    }
    if (body.action === "materials" || body.action === "complete") {
      for (const input of body.lines ?? []) {
        const [line] = await db.select().from(productionMaterialLines).where(eq(productionMaterialLines.id, input.id)).limit(1);
        if (!line || line.executionOrderId !== order.id) continue;
        const [component] = await db.select().from(bomComponents).where(eq(bomComponents.id, line.bomComponentId)).limit(1);
        if (!component) continue;
        const exceeds = deviationBps(input.issuedQuantity, line.theoreticalQuantity) > component.issueToleranceBps
          || deviationBps(input.consumedQuantity, line.theoreticalQuantity) > component.consumptionToleranceBps
          || deviationBps(input.lossQuantity, line.theoreticalQuantity) > component.lossToleranceBps;
        await db.update(productionMaterialLines).set({
          issuedQuantity: Math.max(0, input.issuedQuantity), consumedQuantity: Math.max(0, input.consumedQuantity), lossQuantity: Math.max(0, input.lossQuantity),
          deviationStatus: exceeds ? "pending_approval" : "within_tolerance", updatedAt: now(),
        }).where(eq(productionMaterialLines.id, line.id));
      }
    }
    if (body.action === "complete") {
      if (!["planned", "in_production"].includes(order.status)) {
        return Response.json({ error: "该生产单当前状态不允许重复提交完工。" }, { status: 409 });
      }
      const actual = Number(body.actualFinishedQuantity);
      await assertProductionWarehouse(order.factoryId);
      if (!Number.isFinite(actual) || actual < 0) return Response.json({ error: "实际完工数量必须是非负数。" }, { status: 400 });
      const [item] = await db.select().from(orderItems).where(eq(orderItems.id, order.orderItemId)).limit(1);
      const [sku] = item ? await db.select().from(skus).where(eq(skus.code, item.sku)).limit(1) : [];
      const updatedLines = await db.select().from(productionMaterialLines).where(eq(productionMaterialLines.executionOrderId, order.id));
      const variance = actual - order.plannedQuantity;
      const rate = deviationBps(actual, order.plannedQuantity);
      const over = variance > 0 && rate > (sku?.overproductionToleranceBps ?? 0);
      const under = variance < 0;
      const materialDeviation = updatedLines.some(line => line.deviationStatus === "pending_approval");
      const pending = over || under || materialDeviation;
      const result = over ? "overproduction_quarantined" : under ? "underproduction_pending" : "within_tolerance";
      const report = await insertOne<typeof productionReports.$inferSelect>(db.insert(productionReports).values({
        executionOrderId: order.id, actualFinishedQuantity: actual, varianceQuantity: variance, varianceRateBps: rate, result,
        companyInventoryQuantity: pending ? 0 : actual, factoryOwnedQuantity: 0, reportedBy: access.userId,
      }), id => db.select().from(productionReports).where(eq(productionReports.id, id)).limit(1));
      if (pending) {
        await db.update(executionOrders).set({ status: "variance_pending", completedQuantity: actual, actualFinishAt: now(), updatedAt: now() }).where(eq(executionOrders.id, order.id));
        await db.insert(approvalRequests).values({
          requestNo: `APR-PROD-${Date.now()}`, workflowType: "production_variance", entityType: "production_report", entityId: report.id,
          summary: `${order.executionNo} 完工偏差审批`, payloadJson: JSON.stringify({ executionOrderId: order.id, overproduction: over, underproduction: under, materialDeviation }),
          highRisk: false, status: "pending", requestedBy: access.userId,
        });
      } else {
        await db.update(executionOrders).set({ status: "completed", completedQuantity: actual, actualFinishAt: now(), updatedAt: now() }).where(eq(executionOrders.id, order.id));
        await finalizeProductionInventory({
          executionOrderId: order.id,
          reportId: report.id,
          companyQuantity: actual,
          actorId: access.userId,
        });
      }
    }
    await writeAudit(access, { action: body.action, module: "production", entityType: "execution_order", entityId: order.id, businessNo: order.executionNo, after: body, request });
    return Response.json({ success: true });
  } catch (error) { return accessErrorResponse(error); }
}
