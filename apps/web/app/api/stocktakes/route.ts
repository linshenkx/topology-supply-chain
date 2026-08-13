import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { getDb } from "@database/index";
import { insertOne } from "@database/insert-one";
import { approvalRequests, factories, inventoryBatches, reminderSchedules, stocktakeAdjustments, stocktakeCounts, stocktakes, warehouses } from "@database/schema";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { createReminder } from "../../lib/reminders";
import { retiredPlatformRoute } from "../../lib/retired-writer";

const ACTIVE = ["frozen", "first_count", "recount", "pending_approval"] as const;
const number = (value: unknown) => Math.trunc(Number(value));
const total = (row: { availableQuantity: number; lockedQuantity: number; defectiveQuantity: number; pendingInspectionQuantity: number }) => row.availableQuantity + row.lockedQuantity + row.defectiveQuantity + row.pendingInspectionQuantity;
const changed = (a: ReturnType<typeof quantities>, b: ReturnType<typeof quantities>) => Object.keys(a).some(key => a[key as keyof typeof a] !== b[key as keyof typeof b]);
const quantities = (row: { availableQuantity: number; lockedQuantity: number; defectiveQuantity: number; pendingInspectionQuantity: number }) => ({ availableQuantity: row.availableQuantity, lockedQuantity: row.lockedQuantity, defectiveQuantity: row.defectiveQuantity, pendingInspectionQuantity: row.pendingInspectionQuantity });

export async function GET() {
  return retiredPlatformRoute("/api/v1/stocktakes");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/stocktakes");
  try {
    const access = await requireAccess(request); requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as { warehouseId?: number; scope?: "full_warehouse" | "sku_sample" | "batch"; dueDate?: string; assignedFactoryId?: number; skus?: string[]; batchIds?: number[] };
    if (!body.warehouseId || !body.scope || !body.dueDate) return Response.json({ error: "仓库、盘点范围和截止日期不能为空。" }, { status: 400 });
    if (body.scope === "sku_sample" && !body.skus?.length) return Response.json({ error: "按 SKU 抽盘时至少选择一个 SKU。" }, { status: 400 });
    if (body.scope === "batch" && !body.batchIds?.length) return Response.json({ error: "按批次盘点时至少选择一个批次。" }, { status: 400 });
    if (access.localPreview) return Response.json({ id: 0, preview: true }, { status: 201 });
    const db = getDb();
    const active = await db.select().from(stocktakes).where(and(eq(stocktakes.warehouseId, body.warehouseId), inArray(stocktakes.status, ACTIVE))).limit(1);
    if (active.length) return Response.json({ error: "该仓库已有未完成盘点，不能重复冻结。" }, { status: 409 });
    let filter: SQL | undefined = eq(inventoryBatches.warehouseId, body.warehouseId);
    if (body.scope === "sku_sample") filter = and(filter, inArray(inventoryBatches.sku, body.skus!))!;
    if (body.scope === "batch") filter = and(filter, inArray(inventoryBatches.id, body.batchIds!))!;
    const batches = await db.select().from(inventoryBatches).where(filter);
    if (!batches.length) return Response.json({ error: "盘点范围内没有库存批次。" }, { status: 409 });
    const now = new Date().toISOString();
    const stocktake = await insertOne<typeof stocktakes.$inferSelect>(db.insert(stocktakes).values({ stocktakeNo: `ST-${Date.now()}`, warehouseId: body.warehouseId, scope: body.scope, dueDate: body.dueDate, status: "first_count", frozenAt: now, createdBy: access.userId, assignedFactoryId: body.assignedFactoryId }), id => db.select().from(stocktakes).where(eq(stocktakes.id, id)).limit(1));
    await db.insert(stocktakeCounts).values(batches.map(batch => ({ stocktakeId: stocktake.id, batchId: batch.id, sku: batch.sku, countRound: 0, ...quantities(batch), totalQuantity: total(batch), countedBy: access.userId, countedAt: now })));
    const due = new Date(body.dueDate).getTime();
    for (const days of [30, 15, 7, 3, 1]) await createReminder({ reminderType: "stocktake_due", entityType: "stocktake", entityId: stocktake.id, businessNo: stocktake.stocktakeNo, dueAt: body.dueDate, nextRunAt: new Date(Math.max(Date.now(), due - days * 86400000)).toISOString(), recurrence: "once", recipientRoles: ["factory", "supply_chain"] });
    await createReminder({ reminderType: "stocktake_overdue", entityType: "stocktake", entityId: stocktake.id, businessNo: stocktake.stocktakeNo, dueAt: body.dueDate, nextRunAt: body.dueDate, recurrence: "daily_overdue", recipientRoles: ["factory", "supply_chain"], severity: "red" });
    await writeAudit(access, { action: "create", module: "stocktake", entityType: "stocktake", entityId: stocktake.id, after: { ...stocktake, targetCount: batches.length }, request });
    return Response.json({ stocktake }, { status: 201 });
  } catch (error) { return accessErrorResponse(error); }
}

export async function PATCH(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/stocktakes");
  try {
    const access = await requireAccess(request); requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = await request.json() as { id?: number; action?: "submit_count" | "finish_round"; batchId?: number | null; sku?: string; availableQuantity?: number; lockedQuantity?: number; defectiveQuantity?: number; pendingInspectionQuantity?: number; estimatedProductionDate?: string; estimatedExpiryDate?: string };
    if (!body.id || !body.action) return Response.json({ error: "盘点单和操作不能为空。" }, { status: 400 });
    const db = getDb(); const [task] = await db.select().from(stocktakes).where(eq(stocktakes.id, body.id)).limit(1);
    if (!task) return Response.json({ error: "盘点单不存在。" }, { status: 404 });
    if (!isInternal(access) && task.assignedFactoryId !== access.factoryId) return Response.json({ error: "无权处理该盘点单。" }, { status: 403 });
    const round = task.status === "first_count" ? 1 : task.status === "recount" ? 2 : 0;
    if (!round) return Response.json({ error: "当前状态不能录入盘点结果。" }, { status: 409 });
    if (body.action === "submit_count") {
      const q = { availableQuantity: number(body.availableQuantity), lockedQuantity: number(body.lockedQuantity), defectiveQuantity: number(body.defectiveQuantity), pendingInspectionQuantity: number(body.pendingInspectionQuantity) };
      if (Object.values(q).some(value => value < 0)) return Response.json({ error: "盘点数量不能为负数。" }, { status: 400 });
      if (!body.sku?.trim()) return Response.json({ error: "SKU 不能为空。" }, { status: 400 });
      if (round === 2) {
        const prior = await db.select({ countedBy: stocktakeCounts.countedBy }).from(stocktakeCounts).where(and(eq(stocktakeCounts.stocktakeId, task.id), eq(stocktakeCounts.countRound, 1), eq(stocktakeCounts.countedBy, access.userId))).limit(1);
        if (prior.length) return Response.json({ error: "复盘必须由另一位人员执行。" }, { status: 409 });
      }
      if (body.batchId) {
        const target = await db.select().from(stocktakeCounts).where(and(eq(stocktakeCounts.stocktakeId, task.id), eq(stocktakeCounts.countRound, 0), eq(stocktakeCounts.batchId, body.batchId))).limit(1);
        if (!target.length) return Response.json({ error: "该批次不在盘点范围内。" }, { status: 409 });
      }
      const existing = await db.select().from(stocktakeCounts).where(and(eq(stocktakeCounts.stocktakeId, task.id), eq(stocktakeCounts.countRound, round), eq(stocktakeCounts.sku, body.sku.trim()), body.batchId ? eq(stocktakeCounts.batchId, body.batchId) : isNull(stocktakeCounts.batchId))).limit(1);
      const values = { ...q, totalQuantity: total(q), countedBy: access.userId, countedAt: new Date().toISOString() };
      if (existing.length) await db.update(stocktakeCounts).set(values).where(eq(stocktakeCounts.id, existing[0].id)); else await db.insert(stocktakeCounts).values({ stocktakeId: task.id, batchId: body.batchId ?? null, sku: body.sku.trim(), countRound: round, ...values });
      return Response.json({ success: true });
    }
    const snapshots = await db.select().from(stocktakeCounts).where(and(eq(stocktakeCounts.stocktakeId, task.id), eq(stocktakeCounts.countRound, 0)));
    const counts = await db.select().from(stocktakeCounts).where(and(eq(stocktakeCounts.stocktakeId, task.id), eq(stocktakeCounts.countRound, round)));
    if (snapshots.some(snapshot => !counts.some(count => count.batchId === snapshot.batchId))) return Response.json({ error: "仍有批次尚未盘点，不能结束本轮。" }, { status: 409 });
    const variances = counts.filter(count => {
      const snapshot = snapshots.find(row => row.batchId === count.batchId) ?? { availableQuantity: 0, lockedQuantity: 0, defectiveQuantity: 0, pendingInspectionQuantity: 0 };
      return changed(quantities(snapshot), quantities(count));
    });
    if (!variances.length) {
      await db.update(stocktakes).set({ status: "completed", updatedAt: new Date().toISOString() }).where(eq(stocktakes.id, task.id));
      await db.update(reminderSchedules).set({ status: "completed", updatedAt: new Date().toISOString() }).where(and(eq(reminderSchedules.entityType, "stocktake"), eq(reminderSchedules.entityId, task.id)));
      return Response.json({ success: true, status: "completed" });
    }
    if (round === 1) { await db.update(stocktakes).set({ status: "recount", updatedAt: new Date().toISOString() }).where(eq(stocktakes.id, task.id)); return Response.json({ success: true, status: "recount" }); }
    for (const count of variances) {
      if (!count.batchId && (!body.estimatedProductionDate || !body.estimatedExpiryDate)) return Response.json({ error: "无法识别原批次的盘盈库存必须填写估算生产日期和到期日。" }, { status: 400 });
      const snapshot = snapshots.find(row => row.batchId === count.batchId);
      await db.insert(stocktakeAdjustments).values({ stocktakeId: task.id, stocktakeCountId: count.id, varianceQuantity: count.totalQuantity - (snapshot?.totalQuantity ?? 0), generatedBatchNo: count.batchId ? null : `STG-${task.stocktakeNo}-${count.id}`, estimatedProductionDate: count.batchId ? null : body.estimatedProductionDate, estimatedExpiryDate: count.batchId ? null : body.estimatedExpiryDate });
    }
    const approval = await insertOne<typeof approvalRequests.$inferSelect>(db.insert(approvalRequests).values({ requestNo: `APR-${task.stocktakeNo}-${Date.now()}`, workflowType: "stocktake_variance", entityType: "stocktake", entityId: task.id, summary: `盘点差异审批 ${task.stocktakeNo}`, requestedBy: access.userId, payloadJson: JSON.stringify({ stocktakeId: task.id }), highRisk: false }), id => db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1));
    await db.update(stocktakes).set({ status: "pending_approval", updatedAt: new Date().toISOString() }).where(eq(stocktakes.id, task.id));
    await writeAudit(access, { action: "submit", module: "stocktake", entityType: "stocktake", entityId: task.id, after: { varianceLines: variances.length, approvalId: approval.id }, request });
    return Response.json({ success: true, status: "pending_approval", approvalId: approval.id });
  } catch (error) { return accessErrorResponse(error); }
}
