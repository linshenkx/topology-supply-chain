import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { orderItems, purchaseOrders, purchasePlanItems, purchasePlanOrderLinks, reminderSchedules } from "../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    if (access.localPreview) return Response.json({ orders: [], preview: true });
    const db = getDb();
    const [orders, items, links, planItems, reminders] = await Promise.all([
      db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(200),
      db.select().from(orderItems), db.select().from(purchasePlanOrderLinks),
      db.select().from(purchasePlanItems), db.select().from(reminderSchedules),
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
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/purchase-orders");
}

export async function PATCH() {
  return retiredPlatformRoute("/api/v1/purchase-orders");
}
