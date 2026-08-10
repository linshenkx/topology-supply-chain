import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, bomComponents, productBoms, skuUnitConversions, skus } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

const bps = (value: unknown) => Math.max(0, Math.round(Number(value || 0) * 100));
const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  aFrom <= (bTo || "9999-12-31") && bFrom <= (aTo || "9999-12-31");
const previousDay = (date: string) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};
const lifecycle = (row: typeof productBoms.$inferSelect, today: string) => {
  if (!row.active) return "inactive";
  if (row.approvalStatus !== "approved") return row.approvalStatus;
  if (row.effectiveFrom > today) return "future";
  if (row.effectiveTo && row.effectiveTo < today) return "expired";
  return "effective";
};

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ skus: [], conversions: [], boms: [], components: [], preview: true });
    const db = getDb();
    const internal = isInternal(access);
    const skuRows = internal
      ? await db.select().from(skus).orderBy(desc(skus.updatedAt)).limit(500)
      : await db.select().from(skus).where(eq(skus.status, "active")).limit(500);
    const bomRows = internal
      ? await db.select().from(productBoms).orderBy(desc(productBoms.updatedAt)).limit(500)
      : await db.select().from(productBoms).where(eq(productBoms.approvalStatus, "approved")).limit(500);
    const today = new Date().toISOString().slice(0, 10);
    return Response.json({
      skus: skuRows,
      conversions: await db.select().from(skuUnitConversions).limit(1000),
      boms: bomRows.map(row => ({ ...row, lifecycleStatus: lifecycle(row, today) })),
      components: await db.select().from(bomComponents).limit(2000),
    });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    if (access.localPreview) return Response.json({ success: true, preview: true }, { status: 201 });
    const db = getDb();

    if (action === "create_sku") {
      const code = String(body.code || "").trim().toUpperCase();
      const name = String(body.name || "").trim();
      const itemType = String(body.itemType || "") as "finished" | "auxiliary" | "component";
      const stockUnit = String(body.stockUnit || "").trim();
      if (!code || !name || !stockUnit || !["finished", "auxiliary", "component"].includes(itemType))
        return Response.json({ error: "SKU编码、名称、物料类型和库存单位均为必填项。" }, { status: 400 });
      if ((await db.select().from(skus).where(eq(skus.code, code)).limit(1))[0])
        return Response.json({ error: "SKU编码已存在。" }, { status: 409 });
      const purchaseUnit = String(body.purchaseUnit || "").trim();
      const purchaseQty = Number(body.purchaseUnitQuantity || 0);
      const stockQty = Number(body.stockUnitQuantity || 0);
      const effectiveFrom = String(body.effectiveFrom || "").trim();
      if (purchaseUnit && (!Number.isInteger(purchaseQty) || purchaseQty <= 0 || !Number.isInteger(stockQty) || stockQty <= 0 || !effectiveFrom))
        return Response.json({ error: "填写采购单位后，必须填写正整数换算数量及生效日期。" }, { status: 400 });
      const sku = await insertOne<typeof skus.$inferSelect>(db.insert(skus).values({
        code, name, itemType, stockUnit, serialTrackingEnabled: false,
        overproductionToleranceBps: bps(body.overproductionTolerance), purchaseOverToleranceBps: bps(body.purchaseOverTolerance),
        purchaseUnderToleranceBps: bps(body.purchaseUnderTolerance), verificationStatus: "pending", status: "draft",
      }), id => db.select().from(skus).where(eq(skus.id, id)).limit(1));
      if (purchaseUnit) await db.insert(skuUnitConversions).values({
        skuId: sku.id, purchaseUnit, stockUnit, purchaseUnitQuantity: purchaseQty, stockUnitQuantity: stockQty, effectiveFrom, status: "active",
      });
      await db.insert(approvalRequests).values({
        requestNo: `AP-SKU-${Date.now()}`, workflowType: "sku_verification", entityType: "sku", entityId: sku.id,
        summary: `新增SKU：${code} ${name}`, payloadJson: JSON.stringify(body), requestedBy: access.userId,
      });
      await writeAudit(access, { action: "create", module: "master_data", entityType: "sku", entityId: sku.id, businessNo: code, after: sku, request });
      return Response.json({ sku, approvalRequired: true }, { status: 201 });
    }

    if (action === "create_bom") {
      const finishedSku = String(body.finishedSku || "").trim().toUpperCase();
      const version = String(body.version || "").trim();
      const effectiveFrom = String(body.effectiveFrom || "").trim();
      const effectiveTo = body.effectiveTo ? String(body.effectiveTo) : null;
      const overlapAllowed = body.overlapAllowed === true;
      const overlapReason = String(body.overlapReason || "").trim();
      const lines = Array.isArray(body.components) ? body.components as Array<Record<string, unknown>> : [];
      if (!finishedSku || !version || !effectiveFrom || !lines.length)
        return Response.json({ error: "成品SKU、版本、生效日期和BOM明细均为必填项。" }, { status: 400 });
      if (effectiveTo && effectiveTo < effectiveFrom) return Response.json({ error: "失效日期不能早于生效日期。" }, { status: 400 });
      const [finished] = await db.select().from(skus).where(eq(skus.code, finishedSku)).limit(1);
      if (!finished || finished.itemType !== "finished") return Response.json({ error: "请选择已维护的成品SKU。" }, { status: 400 });
      const existing = await db.select().from(productBoms).where(eq(productBoms.finishedSku, finishedSku));
      if (existing.some(row => row.version === version)) return Response.json({ error: "该成品的BOM版本号已存在。" }, { status: 409 });
      const conflicting = existing.filter(row => row.active && ["pending", "approved"].includes(row.approvalStatus) && overlaps(effectiveFrom, effectiveTo, row.effectiveFrom, row.effectiveTo));
      if (overlapAllowed && (!effectiveTo || !overlapReason))
        return Response.json({ error: "允许重叠时必须填写重叠截止日期和原因。" }, { status: 400 });
      if (!overlapAllowed && conflicting.some(row => row.effectiveFrom >= effectiveFrom))
        return Response.json({ error: "普通新版本的生效日期必须晚于现有冲突版本；如确需并行，请明确允许重叠。" }, { status: 409 });
      const retireBomIds = overlapAllowed ? [] : conflicting.filter(row => row.approvalStatus === "approved").map(row => row.id);

      const seen = new Set<string>();
      const normalized: Array<{ componentSku: string; itemType: "auxiliary" | "component"; isCore: boolean; quantityPerFinished: number; issueToleranceBps: number; consumptionToleranceBps: number; lossToleranceBps: number }> = [];
      for (const line of lines) {
        const componentSku = String(line.componentSku || "").trim().toUpperCase();
        const quantity = Number(line.quantityPerFinished);
        const tolerances = [line.issueTolerance, line.consumptionTolerance, line.lossTolerance].map(Number);
        if (!componentSku || seen.has(componentSku) || !Number.isInteger(quantity) || quantity <= 0)
          return Response.json({ error: "BOM明细SKU不可重复，单件用量必须为正整数。" }, { status: 400 });
        if (tolerances.some(value => !Number.isFinite(value) || value < 0 || value > 100))
          return Response.json({ error: `BOM子项 ${componentSku} 的偏差比例必须在0%至100%之间。` }, { status: 400 });
        const [component] = await db.select().from(skus).where(eq(skus.code, componentSku)).limit(1);
        if (!component || !["auxiliary", "component"].includes(component.itemType || ""))
          return Response.json({ error: `BOM子项 ${componentSku} 不存在或不是辅料/配件。` }, { status: 400 });
        seen.add(componentSku);
        normalized.push({ componentSku, itemType: component.itemType as "auxiliary" | "component", isCore: line.isCore === true,
          quantityPerFinished: quantity, issueToleranceBps: bps(line.issueTolerance), consumptionToleranceBps: bps(line.consumptionTolerance), lossToleranceBps: bps(line.lossTolerance) });
      }
      const bom = await insertOne<typeof productBoms.$inferSelect>(db.insert(productBoms).values({
        finishedSku, version, effectiveFrom, effectiveTo, overlapAllowed, overlapReason, approvalStatus: "pending", active: true, createdBy: access.userId,
      }), id => db.select().from(productBoms).where(eq(productBoms.id, id)).limit(1));
      for (const line of normalized) await db.insert(bomComponents).values({ bomId: bom.id, ...line });
      const approvalPayload = { ...body, retireBomIds, retirementDate: previousDay(effectiveFrom) };
      await db.insert(approvalRequests).values({
        requestNo: `AP-BOM-${Date.now()}`, workflowType: "bom_version", entityType: "bom", entityId: bom.id,
        summary: `BOM版本审批：${finishedSku} / ${version}`, payloadJson: JSON.stringify(approvalPayload), requestedBy: access.userId,
      });
      await writeAudit(access, { action: "create", module: "master_data", entityType: "bom", entityId: bom.id, businessNo: `${finishedSku}-${version}`, after: { bom, components: normalized, retireBomIds }, request });
      return Response.json({ bom, approvalRequired: true, retireBomIds }, { status: 201 });
    }
    return Response.json({ error: "不支持的操作。" }, { status: 400 });
  } catch (error) { return accessErrorResponse(error); }
}
