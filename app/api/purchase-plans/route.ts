import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, factories, factoryPlanResponses, productBoms, purchasePlanItems, purchasePlans, warehouses } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { createReminder } from "../../lib/reminders";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    if (access.localPreview) return Response.json({ plans: [], preview: true });
    const db = getDb();
    const [allPlans, allItems, allFactories, allWarehouses, allResponses] = await Promise.all([
      db.select().from(purchasePlans).orderBy(desc(purchasePlans.createdAt)).limit(200),
      db.select().from(purchasePlanItems),
      db.select().from(factories),
      db.select().from(warehouses),
      db.select().from(factoryPlanResponses).orderBy(desc(factoryPlanResponses.createdAt)),
    ]);
    const factoryNames = new Map(allFactories.map(row => [row.id, row.name]));
    const warehouseNames = new Map(allWarehouses.map(row => [row.id, row.name]));
    const latestResponse = new Map<string, typeof allResponses[number]>();
    for (const row of allResponses) {
      const key = `${row.purchasePlanId}:${row.factoryId}`;
      if (!latestResponse.has(key)) latestResponse.set(key, row);
    }
    const plans = allPlans.flatMap(plan => {
      const items = allItems
        .filter(item => item.purchasePlanId === plan.id && (!access.factoryId || item.factoryId === access.factoryId))
        .map(item => ({
          ...item,
          factoryName: factoryNames.get(item.factoryId) ?? `工厂#${item.factoryId}`,
          warehouseName: warehouseNames.get(item.warehouseId) ?? `仓库#${item.warehouseId}`,
        }));
      if (!items.length) return [];
      const factoryIds = Array.from(new Set(items.map(item => item.factoryId)));
      return [{
        ...plan,
        items,
        responses: factoryIds.map(factoryId => latestResponse.get(`${plan.id}:${factoryId}`)).filter(Boolean),
      }];
    });
    return Response.json({ plans });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json() as {
      id?: number;
      action?: "finalize_ordering";
      decision?: "confirmed" | "unable";
      expectedStartDate?: string;
      expectedFinishDate?: string;
      proposedArrivalDate?: string;
      reason?: string;
    };
    if (body.action === "finalize_ordering") {
      requireRole(access, ["admin", "supply_chain"]);
      if (!body.id) return Response.json({ error: "采购计划不能为空。" }, { status: 400 });
      if (access.localPreview) return Response.json({ success: true, preview: true });
      const db = getDb();
      const [plan] = await db.select().from(purchasePlans).where(eq(purchasePlans.id, body.id)).limit(1);
      if (!plan) return Response.json({ error: "采购计划不存在。" }, { status: 404 });
      const rows = await db.select().from(purchasePlanItems).where(eq(purchasePlanItems.purchasePlanId, plan.id));
      const deviations = rows.flatMap(item => {
        const rateBps = Math.round((item.orderedQuantity - item.plannedQuantity) / item.plannedQuantity * 10000);
        return rateBps < -item.underToleranceBps ? [{ planItemId: item.id, sku: item.sku, type: "under_plan", rateBps }] : [];
      });
      const now = new Date().toISOString();
      for (const item of rows) {
        const deviation = deviations.find(row => row.planItemId === item.id);
        await db.update(purchasePlanItems).set({ completionStatus: deviation ? "under_plan_pending" : "within_tolerance", updatedAt: now }).where(eq(purchasePlanItems.id, item.id));
      }
      if (deviations.length) {
        await db.insert(approvalRequests).values({
          requestNo: `AP-PLAN-CLOSE-${Date.now()}`, workflowType: "purchase_plan_deviation", entityType: "purchase_plan",
          entityId: plan.id, summary: `${plan.planNo}存在未足计划采购`, payloadJson: JSON.stringify(deviations), requestedBy: access.userId,
        });
        await db.update(purchasePlans).set({ status: "ordering", updatedAt: now }).where(eq(purchasePlans.id, plan.id));
      } else {
        await db.update(purchasePlans).set({ status: "ordered_complete", updatedAt: now }).where(eq(purchasePlans.id, plan.id));
      }
      await writeAudit(access, { action: "finalize_ordering", module: "purchase_plans", entityType: "purchase_plan", entityId: plan.id, businessNo: plan.planNo, after: { deviations }, request });
      return Response.json({ success: true, approvalRequired: deviations.length > 0, deviations });
    }
    requireRole(access, ["factory"]);
    if (!body.id || !body.decision || !body.expectedStartDate || !body.expectedFinishDate) {
      return Response.json({ error: "请选择确认结果，并填写预计开工和完工日期。" }, { status: 400 });
    }
    if (!access.factoryId) return Response.json({ error: "当前账号未绑定组装工厂。" }, { status: 403 });
    if (body.decision === "unable" && (!body.reason?.trim() || !body.proposedArrivalDate)) {
      return Response.json({ error: "无法按计划完成时，必须填写原因和建议到货日期。" }, { status: 400 });
    }
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb();
    const [plan] = await db.select().from(purchasePlans).where(eq(purchasePlans.id, body.id)).limit(1);
    if (!plan) return Response.json({ error: "采购计划不存在。" }, { status: 404 });
    const planItems = await db.select().from(purchasePlanItems).where(eq(purchasePlanItems.purchasePlanId, plan.id));
    if (!planItems.some(item => item.factoryId === access.factoryId)) {
      return Response.json({ error: "无权确认其他工厂的采购计划。" }, { status: 403 });
    }
    const response = await insertOne<typeof factoryPlanResponses.$inferSelect>(db.insert(factoryPlanResponses).values({
      purchasePlanId: plan.id,
      factoryId: access.factoryId,
      decision: body.decision,
      expectedStartDate: body.expectedStartDate,
      expectedFinishDate: body.expectedFinishDate,
      proposedArrivalDate: body.proposedArrivalDate,
      reason: body.reason?.trim() ?? "",
      status: body.decision === "confirmed" ? "accepted" : "pending_supply_chain",
      respondedBy: access.userId,
    }), id => db.select().from(factoryPlanResponses).where(eq(factoryPlanResponses.id, id)).limit(1));
    const now = new Date().toISOString();
    if (body.decision === "confirmed") {
      await db.update(purchasePlans).set({ status: "confirmed", confirmedAt: now, updatedAt: now }).where(eq(purchasePlans.id, plan.id));
    } else {
      await db.update(purchasePlans).set({ status: "disputed", updatedAt: now }).where(eq(purchasePlans.id, plan.id));
      await db.insert(approvalRequests).values({
        requestNo: `AP-PLAN-FACTORY-${Date.now()}`,
        workflowType: "purchase_plan_factory_exception",
        entityType: "factory_plan_response",
        entityId: response.id,
        summary: `${plan.planNo}工厂无法按计划完成`,
        payloadJson: JSON.stringify({ planId: plan.id, ...body }),
        requestedBy: access.userId,
      });
    }
    await writeAudit(access, {
      action: body.decision === "confirmed" ? "factory_confirm" : "factory_dispute",
      module: "purchase_plans",
      entityType: "purchase_plan",
      entityId: plan.id,
      businessNo: plan.planNo,
      after: response,
      request,
    });
    return Response.json({ success: true, response });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as {
      planNo?: string; sourceFileKey?: string;
      items?: Array<{ expectedArrivalDate?: string; factoryId?: number; warehouseId?: number; sku?: string; productName?: string; bomId?: number; plannedQuantity?: number; overToleranceBps?: number; underToleranceBps?: number }>;
    };
    if (!body.planNo?.trim() || !body.items?.length) return Response.json({ error: "采购计划编号和明细不能为空。" }, { status: 400 });
    const invalid = body.items.find(item => !item.expectedArrivalDate || !item.factoryId || !item.warehouseId || !item.sku || !item.productName || !item.bomId || !item.plannedQuantity || item.plannedQuantity <= 0);
    if (invalid) return Response.json({ error: "期望到货时间、组装工厂、采购仓库、SKU、有效BOM和计划数量必须完整。" }, { status: 400 });
    if (access.localPreview) return Response.json({ plan: { id: 0, planNo: body.planNo, version: 1 }, preview: true }, { status: 201 });
    const db = getDb();
    const selectedBomIds = Array.from(new Set(body.items.map(item => item.bomId!)));
    const selectedBoms = await db.select().from(productBoms);
    const bomById = new Map(selectedBoms.filter(row => selectedBomIds.includes(row.id)).map(row => [row.id, row]));
    for (const item of body.items) {
      const bom = bomById.get(item.bomId!);
      const businessDate = item.expectedArrivalDate!;
      if (!bom || bom.approvalStatus !== "approved" || !bom.active || bom.finishedSku !== item.sku!.trim()) {
        return Response.json({ error: `SKU ${item.sku} 必须选择该成品已审批且启用的 BOM 版本。` }, { status: 400 });
      }
      if (businessDate < bom.effectiveFrom || (bom.effectiveTo && businessDate > bom.effectiveTo)) {
        return Response.json({ error: `SKU ${item.sku} 所选 BOM ${bom.version} 在期望到货日 ${businessDate} 不在有效期内。` }, { status: 400 });
      }
    }
    const [previous] = await db.select().from(purchasePlans).where(eq(purchasePlans.planNo, body.planNo.trim())).orderBy(desc(purchasePlans.version)).limit(1);
    const version = (previous?.version ?? 0) + 1;
    const approvalRequired = Boolean(previous);
    const plan = await insertOne<typeof purchasePlans.$inferSelect>(db.insert(purchasePlans).values({
      planNo: body.planNo.trim(), version, sourceFileKey: body.sourceFileKey,
      status: approvalRequired ? "pending_approval" : "awaiting_factory_confirmation",
      confirmationDueAt: approvalRequired ? null : new Date(Date.now() + 3 * 86400000).toISOString(),
      createdBy: access.userId,
    }), id => db.select().from(purchasePlans).where(eq(purchasePlans.id, id)).limit(1));
    for (const item of body.items) {
      await db.insert(purchasePlanItems).values({
        purchasePlanId: plan.id, expectedArrivalDate: item.expectedArrivalDate!, factoryId: item.factoryId!,
        warehouseId: item.warehouseId!, sku: item.sku!.trim(), productName: item.productName!.trim(),
        bomId: item.bomId!, plannedQuantity: item.plannedQuantity!,
        overToleranceBps: item.overToleranceBps ?? 0, underToleranceBps: item.underToleranceBps ?? 0,
      });
    }
    if (approvalRequired) await db.insert(approvalRequests).values({
      requestNo: `AP-PLAN-${Date.now()}`, workflowType: "purchase_plan_version", entityType: "purchase_plan",
      entityId: plan.id, summary: `${plan.planNo}发布V${version}版本`, payloadJson: JSON.stringify(body),
      requestedBy: access.userId,
    });
    if (!approvalRequired && plan.confirmationDueAt) await createReminder({
      reminderType: "purchase_plan_confirmation", entityType: "purchase_plan", entityId: plan.id,
      businessNo: plan.planNo, dueAt: plan.confirmationDueAt, nextRunAt: plan.confirmationDueAt,
      recurrence: "daily_overdue", recipientRoles: ["factory", "supply_chain"], severity: "approval",
    });
    await writeAudit(access, { action: "create_version", module: "purchase_plans", entityType: "purchase_plan", entityId: plan.id, businessNo: plan.planNo, after: { ...plan, items: body.items }, request });
    return Response.json({ plan, approvalRequired }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
