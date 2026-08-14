
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import {
  audit,
  domainEvent,
  hasRole,
  integer,
  jsonObject,
  lockVersion,
  oneOf,
  optionalInteger,
  optionalString,
  requireRole,
  type Row,
} from "../../platform/operations-support.js";


export async function submitQualityInspection(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supplier_qc", "company_qc"]);
  const body = jsonObject(raw);
  const executionOrderId = integer(body.executionOrderId, "executionOrderId");
  const stage = oneOf(body.stage, ["incoming", "process", "finished", "finished_goods"] as const, "stage");
  const inspectionMethod = oneOf(body.inspectionMethod, ["sampling", "full"] as const, "inspectionMethod");
  const batchQuantity = integer(body.batchQuantity, "batchQuantity");
  const inspectedQuantity = integer(body.inspectedQuantity, "inspectedQuantity");
  const passedQuantity = integer(body.passedQuantity, "passedQuantity", 0);
  const failedQuantity = integer(body.failedQuantity, "failedQuantity", 0);
  if (passedQuantity + failedQuantity !== inspectedQuantity || inspectedQuantity > batchQuantity) {
    throw new PlatformError(400, "BAD_REQUEST", "Inspection quantities do not balance");
  }
  const defectReason = optionalString(body.defectReason);
  if (failedQuantity > 0 && defectReason.length === 0) throw new PlatformError(400, "BAD_REQUEST", "Defect reason is required");
  const inspectorType = oneOf(body.inspectorType, ["company_qc", "supplier_qc"] as const, "inspectorType");
  if (inspectorType === "company_qc" && !hasRole(command.access, ["admin", "company_qc"])) {
    throw new PlatformError(403, "FORBIDDEN", "Company QC role required");
  }
  if (inspectorType === "supplier_qc" && !hasRole(command.access, ["supplier_qc"])) {
    throw new PlatformError(403, "FORBIDDEN", "Supplier QC role required");
  }
  const orders = await command.transaction.query<Row>(
    `SELECT eo.id, eo.factory_id AS factoryId, oi.sku, oi.item_type AS itemType, oi.supplier_id AS supplierId
     FROM execution_orders eo JOIN order_items oi ON oi.id = eo.order_item_id
     WHERE eo.id = ? LIMIT 1 FOR SHARE`, [executionOrderId],
  );
  const order = orders[0];
  if (order === undefined) throw new PlatformError(404, "NOT_FOUND", "Execution order not found");
  if (inspectorType === "supplier_qc" &&
      (command.access.supplierId === null || Number(order.supplierId) !== command.access.supplierId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden supplier binding");
  }
  const ruleRows = await command.transaction.query<Row>(
    `SELECT id, minimum_pass_rate_bps AS minimumPassRateBps, scope
     FROM quality_rules
     WHERE active = 1 AND stage = ?
       AND ((scope = 'sku' AND sku = ?) OR (scope = 'item_type' AND item_type = ?))
     ORDER BY CASE WHEN scope = 'sku' THEN 0 ELSE 1 END, created_at DESC, id DESC
     LIMIT 1 FOR SHARE`, [stage, order.sku, order.itemType],
  );
  const rule = ruleRows[0];
  if (rule === undefined) throw new PlatformError(409, "CONFLICT", "No active quality rule is configured");
  const passRateBps = Math.round(passedQuantity * 10_000 / inspectedQuantity);
  const systemResult = passRateBps >= Number(rule.minimumPassRateBps) ? "passed" : "failed";
  const requestedResult = body.requestedResult === undefined
    ? null
    : oneOf(body.requestedResult, ["passed", "failed", "conditional"] as const, "requestedResult");
  const requiresApproval = requestedResult !== null && requestedResult !== systemResult;
  const fullInspectionRequired = inspectionMethod === "sampling" && systemResult === "failed";
  const inserted = await command.transaction.execute(
    `INSERT INTO quality_inspections (
       execution_order_id, stage, inspection_method, batch_quantity, inspected_quantity,
       passed_quantity, failed_quantity, pass_rate_bps, quality_rule_id,
       used_item_type_fallback, sku_rule_reminder_status, defect_reason,
       system_result, requested_result, requires_approval, final_result,
       quarantine_triggered, full_inspection_required, source_inspection_id,
       released_quantity, disposition_status, inspector_type, submitted_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [executionOrderId, stage, inspectionMethod, batchQuantity, inspectedQuantity, passedQuantity, failedQuantity,
     passRateBps, rule.id, rule.scope === "item_type" ? 1 : 0, rule.scope === "item_type" ? "pending" : "not_needed",
     defectReason, systemResult, requestedResult, requiresApproval ? 1 : 0,
     requiresApproval ? "pending_approval" : systemResult, systemResult === "failed" ? 1 : 0,
     fullInspectionRequired ? 1 : 0, optionalInteger(body.sourceInspectionId, "sourceInspectionId"),
     systemResult === "failed" ? "pending" : "not_needed", inspectorType, command.access.userId],
  );
  const id = inserted.insertId!;
  await lockVersion(command.transaction, "quality_inspection", id);
  await audit(command.transaction, command.access, command.request, {
    action: "submit", module: "quality", entityType: "quality_inspection", entityId: id,
    after: { executionOrderId, stage, inspectionMethod, batchQuantity, inspectedQuantity, passedQuantity, failedQuantity,
      passRateBps, qualityRuleId: rule.id, systemResult, requiresApproval, finalResult: requiresApproval ? "pending_approval" : systemResult },
  });
  await domainEvent(context, command.transaction, {
    type: systemResult === "failed" ? "DispositionRequired" : "InspectionCompleted",
    aggregateType: "quality_inspection", aggregateId: id,
    payload: { executionOrderId, systemResult, fullInspectionRequired },
  });
  return {
    inspection: { id, executionOrderId, stage, inspectionMethod, passRateBps, qualityRuleId: rule.id,
      systemResult, finalResult: requiresApproval ? "pending_approval" : systemResult,
      requiresApproval, fullInspectionRequired, version: 1 },
  };
}
