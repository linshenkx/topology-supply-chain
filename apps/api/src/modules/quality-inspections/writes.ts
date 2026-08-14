import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
import { requireWarehouseScope } from "../warehouses/support.js";
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

interface InspectionTarget {
  sku: string;
  itemType: string | null;
  supplierId: number | null;
}

export async function submitQualityInspection(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supplier_qc", "company_qc"]);
  const body = jsonObject(raw);
  const executionOrderId = optionalInteger(body.executionOrderId, "executionOrderId");
  const batchId = optionalInteger(body.batchId, "batchId");
  if ((executionOrderId === null) === (batchId === null)) {
    throw new PlatformError(400, "BAD_REQUEST", "Exactly one of executionOrderId or batchId is required");
  }
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

  let target: InspectionTarget;
  if (batchId !== null) {
    const batches = await command.transaction.query<Row>(
      `SELECT id, batch_no AS batchNo, warehouse_id AS warehouseId, sku,
              pending_inspection_quantity AS pendingInspectionQuantity
       FROM inventory_batches WHERE id = ? LIMIT 1 FOR UPDATE`,
      [batchId],
    );
    const batch = batches[0];
    if (batch === undefined) throw new PlatformError(404, "NOT_FOUND", "Inventory batch not found");
    await lockWarehouseFreeze(command.transaction, Number(batch.warehouseId));
    await requireWarehouseScope(command.transaction, command.access, Number(batch.warehouseId));
    if (await freezeExists(command.transaction, Number(batch.warehouseId), String(batch.sku))) {
      throw new PlatformError(409, "CONFLICT", "Inventory is frozen by an active stocktake");
    }
    const pending = Number(batch.pendingInspectionQuantity);
    if (pending <= 0) throw new PlatformError(409, "CONFLICT", "Inventory batch is not pending inspection");
    if (batchQuantity !== pending || inspectedQuantity !== pending) {
      throw new PlatformError(400, "BAD_REQUEST", "Whole pending-inspection batch must be inspected");
    }
    if (inspectionMethod !== "full") {
      throw new PlatformError(400, "BAD_REQUEST", "Whole-batch inspection must use full inspection");
    }
    if (!((passedQuantity === pending && failedQuantity === 0) ||
          (passedQuantity === 0 && failedQuantity === pending))) {
      throw new PlatformError(400, "BAD_REQUEST", "Whole batch must be entirely passed or entirely failed");
    }
    const sources = await command.transaction.query<Row>(
      `SELECT oi.sku, oi.item_type AS itemType, oi.supplier_id AS supplierId
       FROM purchase_receipts pr JOIN order_items oi ON oi.id = pr.order_item_id
       WHERE pr.batch_id = ? LIMIT 1`,
      [batchId],
    );
    let itemType = sources[0]?.itemType == null ? null : String(sources[0].itemType);
    if (itemType === null) {
      const skuRows = await command.transaction.query<Row>(
        `SELECT item_type AS itemType FROM skus WHERE code = ? LIMIT 1`,
        [String(batch.sku)],
      );
      itemType = skuRows[0]?.itemType == null ? null : String(skuRows[0].itemType);
    }
    target = {
      sku: String(batch.sku),
      itemType,
      supplierId: sources[0]?.supplierId == null ? null : Number(sources[0].supplierId),
    };
  } else {
    const orders = await command.transaction.query<Row>(
      `SELECT eo.id, eo.factory_id AS factoryId, oi.sku, oi.item_type AS itemType, oi.supplier_id AS supplierId
       FROM execution_orders eo JOIN order_items oi ON oi.id = eo.order_item_id
       WHERE eo.id = ? LIMIT 1 FOR SHARE`,
      [executionOrderId],
    );
    const order = orders[0];
    if (order === undefined) throw new PlatformError(404, "NOT_FOUND", "Execution order not found");
    target = {
      sku: String(order.sku),
      itemType: order.itemType == null ? null : String(order.itemType),
      supplierId: order.supplierId == null ? null : Number(order.supplierId),
    };
  }

  if (inspectorType === "supplier_qc" &&
      (command.access.supplierId === null || target.supplierId === null || Number(target.supplierId) !== command.access.supplierId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden supplier binding");
  }

  const ruleRows = await command.transaction.query<Row>(
    `SELECT id, minimum_pass_rate_bps AS minimumPassRateBps, scope
     FROM quality_rules
     WHERE active = 1 AND stage = ?
       AND ((scope = 'sku' AND sku = ?) OR (scope = 'item_type' AND item_type = ?))
     ORDER BY CASE WHEN scope = 'sku' THEN 0 ELSE 1 END, created_at DESC, id DESC
     LIMIT 1 FOR SHARE`,
    [stage, target.sku, target.itemType],
  );
  const rule = ruleRows[0];
  if (rule === undefined) throw new PlatformError(409, "CONFLICT", "No active quality rule is configured");
  const passRateBps = Math.round(passedQuantity * 10_000 / inspectedQuantity);
  const systemResult = passRateBps >= Number(rule.minimumPassRateBps) ? "passed" : "failed";
  const requestedResult = body.requestedResult === undefined
    ? null
    : oneOf(body.requestedResult, ["passed", "failed", "conditional"] as const, "requestedResult");
  if (batchId !== null && requestedResult !== null) {
    throw new PlatformError(400, "BAD_REQUEST", "requestedResult is not supported for whole-batch inspection");
  }
  const requiresApproval = requestedResult !== null && requestedResult !== systemResult;
  const fullInspectionRequired = inspectionMethod === "sampling" && systemResult === "failed";
  const finalResult = requiresApproval ? "pending_approval" : systemResult;
  const inserted = await command.transaction.execute(
    `INSERT INTO quality_inspections (
       execution_order_id, batch_id, stage, inspection_method, batch_quantity, inspected_quantity,
       passed_quantity, failed_quantity, pass_rate_bps, quality_rule_id,
       used_item_type_fallback, sku_rule_reminder_status, defect_reason,
       system_result, requested_result, requires_approval, final_result,
       quarantine_triggered, full_inspection_required, source_inspection_id,
       released_quantity, disposition_status, inspector_type, submitted_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [executionOrderId, batchId, stage, inspectionMethod, batchQuantity, inspectedQuantity, passedQuantity, failedQuantity,
     passRateBps, rule.id, rule.scope === "item_type" ? 1 : 0, rule.scope === "item_type" ? "pending" : "not_needed",
     defectReason, systemResult, requestedResult, requiresApproval ? 1 : 0, finalResult,
     systemResult === "failed" ? 1 : 0, fullInspectionRequired ? 1 : 0, optionalInteger(body.sourceInspectionId, "sourceInspectionId"),
     finalResult === "passed" && batchId !== null ? inspectedQuantity : 0,
     systemResult === "failed" ? "pending" : "not_needed", inspectorType, command.access.userId],
  );
  const id = inserted.insertId!;
  await lockVersion(command.transaction, "quality_inspection", id);

  if (batchId !== null && finalResult !== "pending_approval") {
    if (finalResult === "passed") {
      const moved = await command.transaction.execute(
        `UPDATE inventory_batches
         SET pending_inspection_quantity = pending_inspection_quantity - ?,
             available_quantity = available_quantity + ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND pending_inspection_quantity >= ?`,
        [inspectedQuantity, inspectedQuantity, batchId, inspectedQuantity],
      );
      if (moved.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory batch changed concurrently");
      await command.transaction.execute(
        `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
         SELECT warehouse_id, sku, 'inspection_pass', ?, ?, CURRENT_TIMESTAMP(3), ?
         FROM inventory_batches WHERE id = ?`,
        [inspectedQuantity, `quality_inspection:${id}:pass`, command.access.userId, batchId],
      );
    } else {
      const moved = await command.transaction.execute(
        `UPDATE inventory_batches
         SET pending_inspection_quantity = pending_inspection_quantity - ?,
             quarantine_quantity = quarantine_quantity + ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND pending_inspection_quantity >= ?`,
        [inspectedQuantity, inspectedQuantity, batchId, inspectedQuantity],
      );
      if (moved.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory batch changed concurrently");
      await command.transaction.execute(
        `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
         SELECT warehouse_id, sku, 'inspection_fail', ?, ?, CURRENT_TIMESTAMP(3), ?
         FROM inventory_batches WHERE id = ?`,
        [-inspectedQuantity, `quality_inspection:${id}:fail`, command.access.userId, batchId],
      );
    }
  }

  await audit(command.transaction, command.access, command.request, {
    action: "submit", module: "quality", entityType: "quality_inspection", entityId: id,
    after: { executionOrderId, batchId, stage, inspectionMethod, batchQuantity, inspectedQuantity, passedQuantity, failedQuantity,
      passRateBps, qualityRuleId: rule.id, systemResult, requiresApproval, finalResult },
  });
  await domainEvent(context, command.transaction, {
    type: systemResult === "failed" ? "DispositionRequired" : "InspectionCompleted",
    aggregateType: "quality_inspection", aggregateId: id,
    payload: { executionOrderId, batchId, systemResult, fullInspectionRequired },
  });
  return {
    inspection: { id, executionOrderId, batchId, stage, inspectionMethod, passRateBps, qualityRuleId: rule.id,
      systemResult, finalResult, requiresApproval, fullInspectionRequired, version: 1 },
  };
}
