import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, factories, skus, supplierSkus, suppliers } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ relations: [], preview: true });
    const db = getDb();
    let rows: (typeof supplierSkus.$inferSelect)[];
    if (isInternal(access)) rows = await db.select().from(supplierSkus).orderBy(desc(supplierSkus.id)).limit(500);
    else if (access.factoryId) rows = await db.select().from(supplierSkus).where(eq(supplierSkus.factoryId, access.factoryId)).orderBy(desc(supplierSkus.id)).limit(500);
    else if (access.supplierId) rows = await db.select().from(supplierSkus).where(eq(supplierSkus.supplierId, access.supplierId)).orderBy(desc(supplierSkus.id)).limit(500);
    else rows = [];
    const supplierRows = await db.select().from(suppliers).limit(500);
    const factoryRows = await db.select().from(factories).limit(200);
    const skuRows = await db.select().from(skus).where(eq(skus.status, "active")).limit(1000);
    return Response.json({ relations: rows, suppliers: supplierRows, factories: factoryRows, skus: skuRows });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as {
      factoryId?: number; supplierId?: number; sku?: string; isPrimary?: boolean; priority?: number;
      minimumOrderQuantity?: number; packagingMultiple?: number; purchaseUnit?: string;
      leadTimeDays?: number | null; dailyCapacity?: number | null; monthlyCapacity?: number | null; effectiveFrom?: string;
    };
    const factoryId = Number(body.factoryId), supplierId = Number(body.supplierId);
    const positive = (value: unknown, fallback: number) => Math.max(1, Math.trunc(Number(value) || fallback));
    if (!factoryId || !supplierId || !body.sku?.trim() || !body.effectiveFrom) return Response.json({ error: "组装工厂、供应商、SKU和生效日期不能为空。" }, { status: 400 });
    if (access.roles.includes("factory") && access.factoryId !== factoryId) return Response.json({ error: "工厂只能维护本厂管理的供货关系。" }, { status: 403 });
    if (access.localPreview) return Response.json({ relation: { id: 0, ...body }, preview: true }, { status: 201 });
    const db = getDb();
    const [factory] = await db.select().from(factories).where(eq(factories.id, factoryId)).limit(1);
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    const [sku] = await db.select().from(skus).where(and(eq(skus.code, body.sku.trim()), eq(skus.status, "active"))).limit(1);
    if (!factory || !supplier || !sku) return Response.json({ error: "工厂、供应商或已生效SKU不存在。" }, { status: 404 });
    const supplierTier = supplier.tier ?? 1;
    if (supplierTier > 1 && supplier.managedByFactoryId !== factoryId) return Response.json({ error: "第二、三层供应商必须归属于所选组装工厂。" }, { status: 409 });
    const factoryManagedTier3 = access.roles.includes("factory") && supplierTier === 3 && access.factoryId === factoryId;
    const values = {
      factoryId, supplierId, sku: body.sku.trim(), isPrimary: Boolean(body.isPrimary), priority: positive(body.priority, 1),
      minimumOrderQuantity: positive(body.minimumOrderQuantity, 1), packagingMultiple: positive(body.packagingMultiple, 1),
      purchaseUnit: body.purchaseUnit?.trim() || sku.stockUnit || "",
      leadTimeDays: body.leadTimeDays == null ? null : Math.max(0, Math.trunc(Number(body.leadTimeDays))),
      dailyCapacity: body.dailyCapacity == null ? null : positive(body.dailyCapacity, 1),
      monthlyCapacity: body.monthlyCapacity == null ? null : positive(body.monthlyCapacity, 1),
      effectiveFrom: body.effectiveFrom, status: factoryManagedTier3 ? "active" as const : "pending" as const,
      requestedBy: access.userId,
    };
    const [existing] = await db.select().from(supplierSkus).where(and(eq(supplierSkus.factoryId, factoryId), eq(supplierSkus.supplierId, supplierId), eq(supplierSkus.sku, values.sku))).limit(1);
    let relation: typeof supplierSkus.$inferSelect;
    if (existing) {
      await db.update(supplierSkus).set({ ...values, reviewedBy: null, reviewedAt: null, updatedAt: new Date().toISOString() }).where(eq(supplierSkus.id, existing.id));
      [relation] = await db.select().from(supplierSkus).where(eq(supplierSkus.id, existing.id)).limit(1);
    } else relation = await insertOne<typeof supplierSkus.$inferSelect>(db.insert(supplierSkus).values(values), id => db.select().from(supplierSkus).where(eq(supplierSkus.id, id)).limit(1));
    if (!factoryManagedTier3) await db.insert(approvalRequests).values({
      requestNo: `AP-SS-${Date.now()}`, workflowType: "supplier_sku_change", entityType: "supplier_sku", entityId: relation.id,
      summary: `${existing ? "变更" : "新增"}供货关系：${factory.name} / ${supplier.name} / ${sku.code}`,
      payloadJson: JSON.stringify(values), requestedBy: access.userId,
    });
    await writeAudit(access, { action: existing ? "update" : "create", module: "suppliers", entityType: "supplier_sku", entityId: relation.id, businessNo: `${factory.code}-${sku.code}`, before: existing, after: relation, request });
    return Response.json({ relation, approvalRequired: !factoryManagedTier3 }, { status: existing ? 200 : 201 });
  } catch (error) { return accessErrorResponse(error); }
}
