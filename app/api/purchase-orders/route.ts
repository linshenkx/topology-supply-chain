import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, orderItems, purchaseOrders, purchasePlanItems, purchasePlanOrderLinks, purchasePlans, reminderSchedules } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { withDbTransaction } from "../../../db/transaction";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { createReminder } from "../../lib/reminders";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    if (access.localPreview) return Response.json({ orders: [], preview: true });
    const db = getDb();
    const [orders, items, links, planItems, reminders] = await Promise.all([
      db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(200),
      db.select().from(orderItems),
      db.select().from(purchasePlanOrderLinks),
      db.select().from(purchasePlanItems),
      db.select().from(reminderSchedules),
    ]);
    const planItemMap = new Map(planItems.map(row => [row.id, row]));
    const linksByOrderItem = new Map<number, typeof links>();
    for (const link of links) linksByOrderItem.set(link.orderItemId, [...(linksByOrderItem.get(link.orderItemId) ?? []), link]);
    const result = orders.flatMap(order => {
      const orderItemsForOrder = items.filter(item => item.purchaseOrderId === order.id).map(item => {
        const itemLinks = linksByOrderItem.get(item.id) ?? [];
        return { ...item, planLinks: itemLinks.map(link => ({ ...link, planItem: planItemMap.get(link.purchasePlanItemId) })) };
      });
      if (access.factoryId && !orderItemsForOrder.some(item => item.planLinks.some(link => link.planItem?.factoryId === access.factoryId))) return [];
      const reminder = reminders.find(row => row.entityType === "purchase_order" && row.entityId === order.id && row.reminderType === "purchase_order_confirmation" && row.status === "active");
      return [{ ...order, items: orderItemsForOrder, confirmationDueAt: reminder?.dueAt ?? null }];
    });
    return Response.json({ orders: result });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as {
      orderNo?: string; orderDate?: string; sourceFileKey?: string;
      items?: Array<{ planItemId?: number; sku?: string; productName?: string; itemType?: "finished" | "auxiliary" | "component"; supplierId?: number; quantity?: number; unitPriceTaxIncludedMinor?: number; dueDate?: string }>;
    };
    if (!body.orderNo?.trim() || !body.orderDate || !body.items?.length) return Response.json({ error: "采购单号、下单日期和明细不能为空。" }, { status: 400 });
    if (body.items.some(item => !item.planItemId || !item.sku || !item.productName || !item.itemType || !item.quantity || item.quantity <= 0 || !item.dueDate)) {
      return Response.json({ error: "每行必须关联采购计划，并填写SKU、类型、数量和交货日期。" }, { status: 400 });
    }
    if (access.localPreview) return Response.json({ order: { id: 0, orderNo: body.orderNo }, preview: true }, { status: 201 });
    const db = getDb();
    const confirmationDueAt = new Date(Date.now() + 86400000).toISOString();
    const result = await withDbTransaction(db, async tx => {
      const order = await insertOne<typeof purchaseOrders.$inferSelect>(tx.insert(purchaseOrders).values({
        orderNo: body.orderNo!.trim(), sourceFileKey: body.sourceFileKey, orderDate: body.orderDate!,
        status: "factory_confirmation",
        totalTaxIncludedMinor: body.items!.reduce((sum, item) => sum + (item.unitPriceTaxIncludedMinor ?? 0) * (item.quantity ?? 0), 0),
      }), id => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1));
      let approvalRequired = false;
      const deviations: Array<{ planItemId: number; sku: string; type: string; rateBps: number }> = [];
      const affectedPlanIds = new Set<number>();
      for (const item of body.items!) {
        const [planItem] = await tx.select().from(purchasePlanItems).where(eq(purchasePlanItems.id, item.planItemId!)).limit(1);
        if (!planItem) throw new Error(`采购计划明细${item.planItemId}不存在。`);
        affectedPlanIds.add(planItem.purchasePlanId);
        const orderItem = await insertOne<typeof orderItems.$inferSelect>(tx.insert(orderItems).values({
          purchaseOrderId: order.id, sku: item.sku!.trim(), productName: item.productName!.trim(),
          itemType: item.itemType!, supplierId: item.supplierId, quantity: item.quantity!,
          unitPriceTaxIncludedMinor: item.unitPriceTaxIncludedMinor ?? 0,
          amountTaxIncludedMinor: (item.unitPriceTaxIncludedMinor ?? 0) * item.quantity!, dueDate: item.dueDate,
        }), id => tx.select().from(orderItems).where(eq(orderItems.id, id)).limit(1));
        await tx.insert(purchasePlanOrderLinks).values({
          purchasePlanItemId: planItem.id, orderItemId: orderItem.id, allocatedQuantity: item.quantity!,
          matchMethod: "manual", confirmedBy: access.userId,
        });
        const cumulative = planItem.orderedQuantity + item.quantity!;
        const rateBps = Math.round((cumulative - planItem.plannedQuantity) / planItem.plannedQuantity * 10000);
        // 分批下单时，数量不足代表计划仍在执行，只有供应链主动结案时才判断“未足计划采购”。
        const outside = rateBps > planItem.overToleranceBps;
        if (outside) {
          approvalRequired = true;
          deviations.push({ planItemId: planItem.id, sku: item.sku!, type: "over_plan", rateBps });
        }
        await tx.update(purchasePlanItems).set({
          orderedQuantity: cumulative,
          completionStatus: outside ? "over_plan_pending" : rateBps >= -planItem.underToleranceBps ? "within_tolerance" : "not_ordered",
          updatedAt: new Date().toISOString(),
        }).where(eq(purchasePlanItems.id, planItem.id));
      }
      for (const planId of affectedPlanIds) {
        const rows = await tx.select().from(purchasePlanItems).where(eq(purchasePlanItems.purchasePlanId, planId));
        const complete = rows.every(row => ["within_tolerance", "exception_approved"].includes(row.completionStatus));
        await tx.update(purchasePlans).set({ status: complete ? "ordered_complete" : "ordering", updatedAt: new Date().toISOString() }).where(eq(purchasePlans.id, planId));
      }
      if (approvalRequired) await tx.insert(approvalRequests).values({
        requestNo: `AP-PO-${Date.now()}`, workflowType: "purchase_plan_deviation", entityType: "purchase_order",
        entityId: order.id, summary: `${order.orderNo}存在采购计划数量偏差`, payloadJson: JSON.stringify(deviations),
        requestedBy: access.userId,
      });
      return { order, approvalRequired, deviations };
    });
    await createReminder({
      reminderType: "purchase_order_confirmation", entityType: "purchase_order", entityId: result.order.id,
      businessNo: result.order.orderNo, dueAt: confirmationDueAt, nextRunAt: confirmationDueAt,
      recurrence: "daily_overdue", recipientRoles: ["factory", "supply_chain"], severity: "approval",
    });
    await writeAudit(access, { action: "create", module: "purchase_orders", entityType: "purchase_order", entityId: result.order.id, businessNo: result.order.orderNo, after: { ...result.order, items: body.items, deviations: result.deviations }, request });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["factory"]);
    const body = await request.json() as { id?: number; decision?: "confirmed" | "unable"; proposedDueDate?: string; reason?: string };
    if (!body.id || !["confirmed", "unable"].includes(body.decision ?? "")) {
      return Response.json({ error: "采购单和确认结果不能为空。" }, { status: 400 });
    }
    if (body.decision === "unable" && (!body.proposedDueDate || !body.reason?.trim())) {
      return Response.json({ error: "无法按期交货时必须填写原因和建议交货日期。" }, { status: 400 });
    }
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb();
    const [order] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, body.id)).limit(1);
    if (!order) return Response.json({ error: "采购单不存在。" }, { status: 404 });
    if (order.status !== "factory_confirmation") return Response.json({ error: "该采购单当前不需要工厂确认。" }, { status: 409 });
    const items = await db.select().from(orderItems).where(eq(orderItems.purchaseOrderId, order.id));
    const links = await db.select().from(purchasePlanOrderLinks);
    const planItems = await db.select().from(purchasePlanItems);
    const owned = items.some(item => links.some(link => link.orderItemId === item.id && planItems.some(planItem => planItem.id === link.purchasePlanItemId && planItem.factoryId === access.factoryId)));
    if (!owned) return Response.json({ error: "该采购单未分配给当前工厂。" }, { status: 403 });
    const now = new Date().toISOString();
    if (body.decision === "confirmed") {
      await db.update(purchaseOrders).set({ status: "confirmed", updatedAt: now }).where(eq(purchaseOrders.id, order.id));
    } else {
      await withDbTransaction(db, async tx => {
        await tx.update(purchaseOrders).set({ status: "disputed", updatedAt: now }).where(eq(purchaseOrders.id, order.id));
        await tx.insert(approvalRequests).values({
          requestNo: `AP-PO-EX-${Date.now()}`,
          workflowType: "purchase_order_factory_exception",
          entityType: "purchase_order",
          entityId: order.id,
          summary: `${order.orderNo}无法按原日期交货`,
          payloadJson: JSON.stringify({ proposedDueDate: body.proposedDueDate, reason: body.reason!.trim(), factoryId: access.factoryId }),
          requestedBy: access.userId,
        });
      });
    }
    await writeAudit(access, { action: body.decision === "confirmed" ? "confirm" : "request_exception", module: "purchase_orders", entityType: "purchase_order", entityId: order.id, businessNo: order.orderNo, after: body, request });
    return Response.json({ success: true, status: body.decision === "confirmed" ? "confirmed" : "disputed" });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
