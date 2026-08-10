import { and, desc, eq, lte } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "../../../db";
import {
  deliveryBatches,
  executionOrders,
  orderItems,
  supplierPerformanceReviews,
  supplierPerformanceWeightVersions,
  suppliers,
} from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

type MetricKey = "delivery" | "quality" | "exception" | "preparation" | "satisfaction" | "sampling";
type Weights = Record<MetricKey, number>;
const defaults: Record<number, Weights> = {
  1: { delivery: 2500, quality: 2000, exception: 1500, preparation: 1000, satisfaction: 1500, sampling: 1500 },
  2: { delivery: 3000, quality: 2500, exception: 1500, preparation: 1500, satisfaction: 0, sampling: 1500 },
  3: { delivery: 3000, quality: 2500, exception: 2000, preparation: 1000, satisfaction: 0, sampling: 1500 },
};

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function localDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    shanghaiDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function quarterFromDate(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

function currentQuarter() {
  const today = localDate(new Date()) || new Date().toISOString().slice(0, 10);
  return quarterFromDate(today) || `${new Date().getUTCFullYear()}-Q1`;
}
function average(values: number[]) { return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 20 * 10) / 10 : null; }
function parseTags(value: string) { try { const tags = JSON.parse(value); return Array.isArray(tags) ? tags.map(String) : []; } catch { return []; } }

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request); const url = new URL(request.url); const quarter = url.searchParams.get("quarter") || currentQuarter();
    const tierFilter = Number(url.searchParams.get("tier") || 0); const today = localDate(new Date()) || new Date().toISOString().slice(0, 10); const db = getDb();
    const [supplierRows, reviewRows, weightRows, deliveryRows] = await Promise.all([
      db.select().from(suppliers).where(eq(suppliers.status, "active")).limit(500),
      db.select().from(supplierPerformanceReviews).where(eq(supplierPerformanceReviews.quarter, quarter)).limit(5000),
      db.select().from(supplierPerformanceWeightVersions).where(and(eq(supplierPerformanceWeightVersions.status, "active"), lte(supplierPerformanceWeightVersions.effectiveFrom, today))).orderBy(desc(supplierPerformanceWeightVersions.effectiveFrom)).limit(100),
      db.select({
        supplierId: orderItems.supplierId,
        plannedShipAt: deliveryBatches.plannedShipAt,
        shippedAt: deliveryBatches.shippedAt,
      })
        .from(deliveryBatches)
        .innerJoin(executionOrders, eq(deliveryBatches.executionOrderId, executionOrders.id))
        .innerJoin(orderItems, eq(executionOrders.orderItemId, orderItems.id))
        .limit(20000),
    ]);
    const selectedWeights = new Map<number, Weights>();
    for (const row of weightRows) if (!selectedWeights.has(row.tier)) selectedWeights.set(row.tier, { delivery: row.deliveryWeightBps, quality: row.qualityWeightBps, exception: row.exceptionWeightBps, preparation: row.preparationWeightBps, satisfaction: row.satisfactionWeightBps, sampling: row.samplingWeightBps });
    const deliveryBySupplier = new Map<number, { total: number; onTime: number }>();
    for (const row of deliveryRows) {
      const supplierId = Number(row.supplierId);
      if (!supplierId || !row.plannedShipAt) continue;
      const plannedDate = localDate(row.plannedShipAt);
      if (!plannedDate || quarterFromDate(plannedDate) !== quarter) continue;
      const shippedDate = row.shippedAt ? localDate(row.shippedAt) : null;
      if (!shippedDate && plannedDate >= today) continue;
      const stats = deliveryBySupplier.get(supplierId) || { total: 0, onTime: 0 };
      stats.total += 1;
      if (shippedDate === plannedDate) stats.onTime += 1;
      deliveryBySupplier.set(supplierId, stats);
    }
    const raw = supplierRows.filter(s => [1, 2, 3].includes(s.tier || 0) && (!tierFilter || s.tier === tierFilter)).map(supplier => {
      const own = reviewRows.filter(r => r.supplierId === supplier.id); const satisfaction = average(own.filter(r => r.reviewType === "satisfaction").map(r => r.score)); const sampling = average(own.filter(r => r.reviewType === "sampling").map(r => r.score));
      const deliveryStats = deliveryBySupplier.get(Number(supplier.id));
      const delivery = deliveryStats?.total
        ? Math.round((deliveryStats.onTime / deliveryStats.total) * 1000) / 10
        : null;
      const metrics: Record<MetricKey, number | null> = { delivery, quality: null, exception: null, preparation: null, satisfaction: supplier.tier === 1 ? satisfaction : null, sampling };
      const weights = selectedWeights.get(supplier.tier || 1) || defaults[supplier.tier || 1]; const available = (Object.keys(metrics) as MetricKey[]).filter(k => metrics[k] !== null && weights[k] > 0); const denominator = available.reduce((sum, k) => sum + weights[k], 0);
      const score = denominator ? Math.round(available.reduce((sum, k) => sum + (metrics[k] || 0) * weights[k], 0) / denominator * 10) / 10 : null;
      const comments = own.filter(r => r.comment.trim()).map(r => ({ type: r.reviewType, comment: r.comment, tags: parseTags(r.tagsJson) }));
      const reveal = isInternal(access) || access.supplierId === supplier.id || (!!access.factoryId && supplier.managedByFactoryId === access.factoryId);
      return { supplierId: supplier.id, supplierCode: reveal ? supplier.code : null, supplierName: reveal ? supplier.name : null, tier: supplier.tier, score, metrics, automaticMetricEvidence: { delivery: { evaluatedBatches: deliveryStats?.total || 0, onTimeBatches: deliveryStats?.onTime || 0 } }, reviewCounts: { satisfaction: own.filter(r => r.reviewType === "satisfaction").length, sampling: own.filter(r => r.reviewType === "sampling").length }, comments, reveal };
    });
    const rankings = raw.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map((row, index) => ({ ...row, rank: index + 1, displayName: row.reveal ? row.supplierName : `第${index + 1}名企业` }));
    const payload = { quarter, rankings, weights: [1, 2, 3].map(tier => ({ tier, ...(selectedWeights.get(tier) || defaults[tier]) })), canConfigure: access.roles.some(r => ["admin", "supply_chain"].includes(r)), canReview: access.roles.some(r => ["admin", "supply_chain", "company_qc"].includes(r)), automaticMetricsPending: true };
    if (url.searchParams.get("format") === "xlsx") {
      const watermark = `导出人：${access.name}（${access.email}）｜导出时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`; const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["广州拓扑睡眠科技有限公司 供应商绩效排名"], [watermark], ["季度", quarter], ["说明", "未形成业务数据的自动指标不参与当期加权计算。"]]), "导出说明");
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rankings.map(r => ({ 排名: r.rank, 供应商: r.displayName, 层级: `第${r.tier}层`, 综合分: r.score ?? "待评价", 准时交付率: r.metrics.delivery ?? "待业务数据形成", 质检合格率: r.metrics.quality ?? "待业务数据形成", 异常处理及时率: r.metrics.exception ?? "待业务数据形成", 备料按期完成率: r.metrics.preparation ?? "待业务数据形成", 内部满意度: r.metrics.satisfaction ?? "不适用/待评价", 打样配合度: r.metrics.sampling ?? "待评价", 水印: watermark }))), "绩效排名");
      await writeAudit(access, { action: "export_supplier_performance", module: "supplier_performance", entityType: "supplier_ranking", entityId: quarter, exported: true, sensitiveView: true, after: { count: rankings.length }, request });
      const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }); return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="supplier-performance-${quarter}.xlsx"`, "Cache-Control": "no-store" } });
    }
    return Response.json(payload);
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request); const body = await request.json() as Record<string, unknown>; const db = getDb();
    if (body.action === "review") {
      requireRole(access, ["admin", "supply_chain", "company_qc"]); const supplierId = Number(body.supplierId); const quarter = String(body.quarter || ""); const reviewType = String(body.reviewType || ""); const score = Number(body.score);
      if (!supplierId || !/^\d{4}-Q[1-4]$/.test(quarter) || !["satisfaction", "sampling"].includes(reviewType) || score < 1 || score > 5) return Response.json({ error: "请完整填写供应商、季度、评价类型和1–5分评分。" }, { status: 400 });
      const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1); if (!supplier) return Response.json({ error: "供应商不存在。" }, { status: 404 }); if (reviewType === "satisfaction" && supplier.tier !== 1) return Response.json({ error: "内部满意度仅用于第一层组装工厂。" }, { status: 400 });
      const where = and(eq(supplierPerformanceReviews.supplierId, supplierId), eq(supplierPerformanceReviews.quarter, quarter), eq(supplierPerformanceReviews.reviewType, reviewType as "satisfaction" | "sampling"), eq(supplierPerformanceReviews.evaluatorUserId, access.userId)); const [existing] = await db.select().from(supplierPerformanceReviews).where(where).limit(1);
      const values = { score, tagsJson: JSON.stringify(Array.isArray(body.tags) ? body.tags.map(String) : []), comment: String(body.comment || "").trim(), updatedAt: new Date().toISOString() };
      if (existing) await db.update(supplierPerformanceReviews).set(values).where(eq(supplierPerformanceReviews.id, existing.id)); else await db.insert(supplierPerformanceReviews).values({ supplierId, quarter, reviewType: reviewType as "satisfaction" | "sampling", evaluatorUserId: access.userId, ...values });
      await writeAudit(access, { action: existing ? "update_review" : "create_review", module: "supplier_performance", entityType: "supplier_review", entityId: `${supplierId}-${quarter}-${reviewType}-${access.userId}`, businessNo: supplier.code, before: existing, after: { ...values, reviewerIdentityHiddenExternally: true }, request }); return Response.json({ ok: true });
    }
    if (body.action === "weights") {
      requireRole(access, ["admin", "supply_chain"]); const tier = Number(body.tier); const effectiveFrom = String(body.effectiveFrom || ""); const keys: MetricKey[] = ["delivery", "quality", "exception", "preparation", "satisfaction", "sampling"]; const weights = Object.fromEntries(keys.map(k => [k, Math.round(Number(body[k]) * 100)])) as Weights;
      if (![1, 2, 3].includes(tier) || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || keys.some(k => !Number.isFinite(weights[k]) || weights[k] < 0) || Object.values(weights).reduce((a, b) => a + b, 0) !== 10000 || (tier !== 1 && weights.satisfaction !== 0)) return Response.json({ error: "权重必须为非负数且合计100%；第二、三层满意度权重必须为0。" }, { status: 400 });
      const where = and(eq(supplierPerformanceWeightVersions.tier, tier), eq(supplierPerformanceWeightVersions.effectiveFrom, effectiveFrom)); const [existing] = await db.select().from(supplierPerformanceWeightVersions).where(where).limit(1); const values = { deliveryWeightBps: weights.delivery, qualityWeightBps: weights.quality, exceptionWeightBps: weights.exception, preparationWeightBps: weights.preparation, satisfactionWeightBps: weights.satisfaction, samplingWeightBps: weights.sampling, status: "active" as const, updatedAt: new Date().toISOString() };
      if (existing) await db.update(supplierPerformanceWeightVersions).set(values).where(eq(supplierPerformanceWeightVersions.id, existing.id)); else await db.insert(supplierPerformanceWeightVersions).values({ tier, effectiveFrom, createdBy: access.userId, ...values });
      await writeAudit(access, { action: existing ? "update_weights" : "create_weights", module: "supplier_performance", entityType: "performance_weights", entityId: `${tier}-${effectiveFrom}`, before: existing, after: values, request }); return Response.json({ ok: true });
    }
    return Response.json({ error: "不支持的操作。" }, { status: 400 });
  } catch (error) { return accessErrorResponse(error); }
}
