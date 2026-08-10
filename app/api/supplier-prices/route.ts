import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, corePriceAgreements, corePriceChangeRequests, orderItems, purchaseOrders, skus, supplierSkus, suppliers } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

const previousDay = (date: string) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); };

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
      for (const period of [day, day.slice(0, 7)]) { const key = `${item.supplierId}|${item.sku}|${period}`; demand.set(key, (demand.get(key) ?? 0) + item.quantity); }
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

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request); requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { supplierId?: number; sku?: string; taxIncludedMinor?: number; taxExcludedMinor?: number; taxRateBps?: number; effectiveFrom?: string; reason?: string; evidenceFileKey?: string };
    const supplierId = Number(body.supplierId), skuCode = body.sku?.trim() ?? "", included = Math.trunc(Number(body.taxIncludedMinor)), excluded = Math.trunc(Number(body.taxExcludedMinor)), taxRate = Math.trunc(Number(body.taxRateBps));
    if (!supplierId || !skuCode || included <= 0 || excluded <= 0 || taxRate < 0 || taxRate > 10000 || !body.effectiveFrom || !body.reason?.trim() || !body.evidenceFileKey?.trim()) return Response.json({ error: "供应商、SKU、含税/未税价、税率、生效日期、变更原因和价格凭证均为必填项。" }, { status: 400 });
    if (access.localPreview) return Response.json({ request: { id: 0, ...body }, preview: true }, { status: 201 });
    const db = getDb();
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    const [sku] = await db.select().from(skus).where(and(eq(skus.code, skuCode), eq(skus.status, "active"))).limit(1);
    if (!supplier || !sku) return Response.json({ error: "供应商或已生效SKU不存在。" }, { status: 404 });
    const isTier3Factory = supplier.tier === 3 && access.roles.includes("factory") && supplier.managedByFactoryId === access.factoryId;
    if (supplier.tier === 3 && isInternal(access)) return Response.json({ error: "第三层供应商价格由所属组装工厂维护，公司供应链只有查看权限。" }, { status: 403 });
    if (!isTier3Factory && !isInternal(access)) return Response.json({ error: "当前账号不能维护该供应商价格。" }, { status: 403 });
    const [current] = await db.select().from(corePriceAgreements).where(and(eq(corePriceAgreements.supplierId, supplierId), eq(corePriceAgreements.sku, skuCode), eq(corePriceAgreements.status, "active"))).orderBy(desc(corePriceAgreements.effectiveFrom)).limit(1);
    const values = { currentAgreementId: current?.id ?? null, supplierId, sku: skuCode, proposedTaxIncludedMinor: included, proposedTaxExcludedMinor: excluded, proposedTaxRateBps: taxRate, proposedEffectiveFrom: body.effectiveFrom, reason: body.reason.trim(), evidenceFileKey: body.evidenceFileKey.trim(), requestedBy: access.userId };
    if (isTier3Factory) {
      if (current) await db.update(corePriceAgreements).set({ effectiveTo: previousDay(body.effectiveFrom), status: "inactive", updatedAt: new Date().toISOString() }).where(eq(corePriceAgreements.id, current.id));
      const agreement = await insertOne<typeof corePriceAgreements.$inferSelect>(db.insert(corePriceAgreements).values({ supplierId, sku: skuCode, currency: "CNY", unitPriceTaxIncludedMinor: included, unitPriceTaxExcludedMinor: excluded, taxRateBps: taxRate, effectiveFrom: body.effectiveFrom, maintainedBy: access.userId }), id => db.select().from(corePriceAgreements).where(eq(corePriceAgreements.id, id)).limit(1));
      await writeAudit(access, { action: "create", module: "supplier_prices", entityType: "price_agreement", entityId: agreement.id, businessNo: `${supplier.code}-${skuCode}`, after: agreement, request });
      return Response.json({ agreement, approvalRequired: false }, { status: 201 });
    }
    const change = await insertOne<typeof corePriceChangeRequests.$inferSelect>(db.insert(corePriceChangeRequests).values(values), id => db.select().from(corePriceChangeRequests).where(eq(corePriceChangeRequests.id, id)).limit(1));
    await db.insert(approvalRequests).values({ requestNo: `AP-PRICE-${Date.now()}`, workflowType: "supplier_price_change", entityType: "supplier_price_change", entityId: change.id, summary: `${current ? "变更" : "新增"}供应商价格：${supplier.name} / ${skuCode}`, payloadJson: JSON.stringify(values), requestedBy: access.userId, highRisk: true });
    await writeAudit(access, { action: "create", module: "supplier_prices", entityType: "price_change_request", entityId: change.id, businessNo: `${supplier.code}-${skuCode}`, after: change, request });
    return Response.json({ request: change, approvalRequired: true }, { status: 201 });
  } catch (error) { return accessErrorResponse(error); }
}
