import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { corePriceAgreements, corePriceChangeRequests, orderItems, purchaseOrders, skus, supplierSkus, suppliers } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ agreements: [], requests: [], suppliers: [], skus: [], relations: [], risks: [], preview: true });
    const db = getDb();
    const [supplierRows, skuRows, relationRows, agreementRows, requestRows, orders, items] = await Promise.all([
      db.select().from(suppliers).limit(500), db.select().from(skus).where(eq(skus.status, "active")).limit(1000),
      db.select().from(supplierSkus).where(eq(supplierSkus.status, "active")).limit(2000), db.select().from(corePriceAgreements).orderBy(desc(corePriceAgreements.effectiveFrom)).limit(2000),
      db.select().from(corePriceChangeRequests).orderBy(desc(corePriceChangeRequests.id)).limit(500), db.select().from(purchaseOrders).limit(2000), db.select().from(orderItems).limit(5000),
    ]);
    let allowed = new Set<number>();
    if (isInternal(access)) allowed = new Set(supplierRows.map(row => row.id));
    else if (access.factoryId) allowed = new Set(relationRows.filter(row => row.factoryId === access.factoryId).map(row => row.supplierId));
    else if (access.supplierId) allowed.add(access.supplierId);
    const relations = relationRows.filter(row => allowed.has(row.supplierId));
    const openOrderIds = new Set(orders.filter(row => !["completed", "closed", "cancelled"].includes(row.status)).map(row => row.id));
    const demand = new Map<string, number>();
    for (const item of items) {
      if (!item.supplierId || !item.dueDate || !allowed.has(item.supplierId) || !openOrderIds.has(item.purchaseOrderId)) continue;
      const day = item.dueDate.slice(0, 10);
      for (const period of [day, day.slice(0, 7)]) {
        const key = `${item.supplierId}|${item.sku}|${period}`;
        demand.set(key, (demand.get(key) ?? 0) + item.quantity);
      }
    }
    const risks: Array<Record<string, string | number>> = [];
    for (const relation of relations) for (const [periodType, capacity] of [["day", relation.dailyCapacity], ["month", relation.monthlyCapacity]] as const) {
      if (!capacity) continue;
      for (const [key, quantity] of demand) {
        const [supplierId, sku, period] = key.split("|");
        if ((periodType === "day" ? period.length === 10 : period.length === 7) && Number(supplierId) === relation.supplierId && sku === relation.sku && quantity > capacity) risks.push({ relationId: relation.id, factoryId: relation.factoryId, supplierId: relation.supplierId, sku, periodType, period, demand: quantity, capacity, excess: quantity - capacity });
      }
    }
    await writeAudit(access, { action: "view", module: "supplier_prices", entityType: "price_list", entityId: "latest", sensitiveView: true, request });
    return Response.json({ agreements: agreementRows.filter(row => allowed.has(row.supplierId)), requests: requestRows.filter(row => allowed.has(row.supplierId)), suppliers: supplierRows.filter(row => allowed.has(row.id)), skus: skuRows, relations, risks });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/supplier-prices");
}
