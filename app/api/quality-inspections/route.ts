import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  executionOrders,
  qualityInspections,
  qualityRules,
} from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import {
  accessErrorResponse,
  isInternal,
  requireAccess,
  requireRole,
} from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { evaluateInspection } from "../../lib/business-rules";
import { retiredPlatformRoute } from "../../lib/retired-writer";

const DEFAULT_PASS_RATE_BPS = 9500;

export async function GET() {
  return retiredPlatformRoute("/api/v1/quality-inspections");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/quality-inspections");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supplier_qc", "company_qc"]);
    const body = (await request.json()) as {
      executionOrderId?: number;
      sku?: string;
      itemType?: "finished" | "auxiliary" | "component";
      stage?: "incoming" | "finished_goods";
      inspectionMethod?: "sampling" | "full";
      batchQuantity?: number;
      inspectedQuantity?: number;
      passedQuantity?: number;
      failedQuantity?: number;
      defectReason?: string;
      requestedResult?: "passed" | "failed";
    };
    const batchQuantity = Math.trunc(Number(body.batchQuantity));
    const inspectedQuantity = Math.trunc(Number(body.inspectedQuantity));
    const passedQuantity = Math.trunc(Number(body.passedQuantity));
    const failedQuantity = Math.trunc(Number(body.failedQuantity));
    if (
      !body.executionOrderId ||
      !body.sku?.trim() ||
      !body.itemType ||
      !body.stage ||
      !body.inspectionMethod ||
      batchQuantity <= 0 ||
      inspectedQuantity <= 0 ||
      passedQuantity < 0 ||
      failedQuantity < 0
    ) {
      return Response.json({ error: "质检任务、SKU、阶段及数量信息不完整。" }, { status: 400 });
    }
    if (passedQuantity + failedQuantity !== inspectedQuantity || inspectedQuantity > batchQuantity) {
      return Response.json(
        { error: "合格数与不合格数之和必须等于检验数，且检验数不能大于批次数量。" },
        { status: 400 },
      );
    }
    if (failedQuantity > 0 && !body.defectReason?.trim()) {
      return Response.json({ error: "存在不合格品时必须填写不良原因。" }, { status: 400 });
    }

    const previewEvaluation = evaluateInspection({
      inspectedQuantity,
      passedQuantity,
      inspectionMethod: body.inspectionMethod,
    });
    const passRateBps = previewEvaluation.passRateBps;
    if (access.localPreview) {
      return Response.json(
        {
          inspection: {
            id: 0,
            passRateBps,
            minimumPassRateBps: DEFAULT_PASS_RATE_BPS,
            systemResult: previewEvaluation.systemResult,
            finalResult: previewEvaluation.systemResult,
            fullInspectionRequired: previewEvaluation.fullInspectionRequired,
          },
          preview: true,
        },
        { status: 201 },
      );
    }

    const db = getDb();
    const [order] = await db
      .select()
      .from(executionOrders)
      .where(eq(executionOrders.id, body.executionOrderId))
      .limit(1);
    if (!order) return Response.json({ error: "执行单不存在。" }, { status: 404 });
    if (!isInternal(access) && order.factoryId !== access.factoryId) {
      return Response.json({ error: "无权提交该执行单的质检结果。" }, { status: 403 });
    }

    let [rule] = await db
      .select()
      .from(qualityRules)
      .where(
        and(
          eq(qualityRules.scope, "sku"),
          eq(qualityRules.sku, body.sku.trim()),
          eq(qualityRules.stage, body.stage),
          eq(qualityRules.active, true),
        ),
      )
      .orderBy(desc(qualityRules.createdAt))
      .limit(1);
    let usedItemTypeFallback = false;
    if (!rule) {
      [rule] = await db
        .select()
        .from(qualityRules)
        .where(
          and(
            eq(qualityRules.scope, "item_type"),
            eq(qualityRules.itemType, body.itemType),
            eq(qualityRules.stage, body.stage),
            eq(qualityRules.active, true),
          ),
        )
        .orderBy(desc(qualityRules.createdAt))
        .limit(1);
      usedItemTypeFallback = true;
    }
    if (!rule) {
      rule = await insertOne<typeof qualityRules.$inferSelect>(
        db.insert(qualityRules).values({
          scope: "item_type",
          itemType: body.itemType,
          stage: body.stage,
          minimumPassRateBps: DEFAULT_PASS_RATE_BPS,
          source: "system_default",
          createdBy: access.userId,
        }),
        id => db.select().from(qualityRules).where(eq(qualityRules.id, id)).limit(1),
      );
      usedItemTypeFallback = true;
    }

    const evaluation = evaluateInspection({
      inspectedQuantity,
      passedQuantity,
      inspectionMethod: body.inspectionMethod,
      minimumPassRateBps: rule.minimumPassRateBps,
    });
    const systemResult = evaluation.systemResult;
    const requiresApproval = Boolean(body.requestedResult && body.requestedResult !== systemResult);
    const finalResult = requiresApproval ? "pending_approval" : systemResult;
    const inspection = await insertOne<typeof qualityInspections.$inferSelect>(
      db.insert(qualityInspections).values({
        executionOrderId: body.executionOrderId,
        stage: body.stage,
        inspectionMethod: body.inspectionMethod,
        batchQuantity,
        inspectedQuantity,
        passedQuantity,
        failedQuantity,
        passRateBps,
        qualityRuleId: rule.id,
        usedItemTypeFallback,
        skuRuleReminderStatus: usedItemTypeFallback ? "pending" : "not_needed",
        defectReason: body.defectReason?.trim() ?? "",
        systemResult,
        requestedResult: body.requestedResult,
        requiresApproval,
        finalResult,
        quarantineTriggered: evaluation.quarantineTriggered,
        fullInspectionRequired: evaluation.fullInspectionRequired,
        dispositionStatus: systemResult === "failed" ? "pending" : "not_needed",
        inspectorType: access.roles.includes("company_qc") ? "company_qc" : "supplier_qc",
        submittedBy: access.userId,
      }),
      id => db.select().from(qualityInspections).where(eq(qualityInspections.id, id)).limit(1),
    );
    await writeAudit(access, {
      action: "submit",
      module: "quality",
      entityType: "quality_inspection",
      entityId: inspection.id,
      after: inspection,
      request,
    });
    return Response.json(
      {
        inspection,
        warning: usedItemTypeFallback
          ? "当前 SKU 尚未维护独立合格率，已采用物料类型默认标准 95%，请供应链维护 SKU 标准。"
          : undefined,
      },
      { status: 201 },
    );
  } catch (error) {
    return accessErrorResponse(error);
  }
}
