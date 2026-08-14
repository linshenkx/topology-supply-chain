import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { consumeStepUpClaim, type ApprovalEffectPort } from "../../platform/approvals.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
import {
  audit,
  domainEvent,
  integer,
  jsonObject,
  oneOf,
  optionalString,
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";

const FULFILLMENT_WORKFLOWS = new Set([
  "warehouse_transfer",
  "warehouse_merge",
  "stocktake_variance",
  "production_variance",
  "shipment_deviation",
  "financial_record_correction",
]);

function requiredRoles(workflow: string): readonly string[] {
  if (workflow === "user_role_change") return ["admin"];
  return workflow === "financial_record_correction"
    ? ["admin", "finance"]
    : ["admin", "supply_chain"];
}

interface ApprovalBinding {
  effectKey: string;
  effectAction: string;
  objectType: "approval" | "r2:approval_request";
  objectVersion: number;
  stepUpAction: string;
}

async function approvalBinding(
  context: DomainRegistrationContext,
  transaction: OperationsCommandContext["transaction"],
  approval: Row,
  decision: "approved" | "rejected",
): Promise<ApprovalBinding> {
  const workflow = String(approval.workflowType);
  const registered = new Set(context.approvalEffects.registeredTypes());
  if (workflow === "user_role_change" && registered.has("r1.user_role_change")) {
    return { effectKey: "r1.user_role_change", effectAction: decision, objectType: "approval",
      objectVersion: integer(approval.objectVersion, "objectVersion"), stepUpAction: "review" };
  }
  const procurementResourceKey = `r2.${workflow}`;
  if (registered.has(procurementResourceKey)) {
    const versions = await transaction.query<Row>(
      `SELECT version FROM resource_versions
       WHERE resource_type = 'approval_request' AND resource_id = ? LIMIT 1 FOR UPDATE`, [String(approval.id)],
    );
    if (versions[0] === undefined) {
      throw new PlatformError(409, "VERSION_CONFLICT", "R2 approval version is unavailable");
    }
    return { effectKey: procurementResourceKey, effectAction: decision === "approved" ? "approve" : "reject",
      objectType: "r2:approval_request", objectVersion: integer(versions[0].version, "objectVersion"),
      stepUpAction: decision === "approved" ? "approve" : "reject" };
  }
  if (FULFILLMENT_WORKFLOWS.has(workflow) && registered.has(workflow)) {
    return { effectKey: workflow, effectAction: decision, objectType: "approval",
      objectVersion: integer(approval.objectVersion, "objectVersion"), stepUpAction: "review" };
  }
  throw new PlatformError(403, "FORBIDDEN", "Approval workflow owner is not registered");
}

function parsedPayload(row: Row): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(row.payloadJson ?? "{}"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid payload");
    return value as Record<string, unknown>;
  } catch {
    throw new PlatformError(409, "CONFLICT", "Approval payload is invalid");
  }
}

async function approvalRow(transaction: OperationsCommandContext["transaction"], id: number): Promise<Row> {
  const rows = await transaction.query<Row>(
    `SELECT id, request_no AS requestNo, workflow_type AS workflowType,
            entity_type AS entityType, entity_id AS entityId, payload_json AS payloadJson,
            high_risk AS highRisk, status, requested_by AS requestedBy,
            CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
     FROM approval_requests WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const row = rows[0];
  if (row === undefined) throw new PlatformError(404, "NOT_FOUND", "Approval not found");
  return row;
}

export async function decideApproval(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const body = jsonObject(raw);
  const id = integer(body.id, "id");
  const decision = oneOf(body.decision, ["approved", "rejected"] as const, "decision");
  const comment = optionalString(body.comment);
  const approval = await approvalRow(command.transaction, id);
  const workflow = String(approval.workflowType);
  const binding = await approvalBinding(context, command.transaction, approval, decision);
  requireRole(command.access, requiredRoles(workflow));
  if (Number(approval.requestedBy) === command.access.userId) {
    throw new PlatformError(409, "CONFLICT", "Requester cannot review their own approval");
  }
  if (approval.status !== "pending") throw new PlatformError(409, "VERSION_CONFLICT", "Approval was already decided");
  const finalPayload = { id, decision, comment };
  if (Number(approval.highRisk) === 1) {
    if (command.access.sessionId === null) throw new PlatformError(403, "FORBIDDEN", "Step-up requires an authenticated session");
    await consumeStepUpClaim(command.transaction, {
      challengeNo: string(body.challengeNo, "challengeNo", 191),
      userId: command.access.userId,
      sessionId: command.access.sessionId,
      action: binding.stepUpAction,
      objectType: binding.objectType,
      objectId: String(id),
      objectVersion: binding.objectVersion,
      requestDigest: (await import("node:crypto")).createHash("sha256")
        .update(canonical(finalPayload), "utf8").digest("hex"),
    });
  }
  const claimed = await command.transaction.execute(
    `UPDATE approval_requests
     SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), review_comment = ?,
         sms_verified_at = CASE WHEN high_risk = 1 THEN CURRENT_TIMESTAMP(3) ELSE NULL END,
         updated_at = GREATEST(DATE_ADD(updated_at, INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))
     WHERE id = ? AND status = 'pending'`,
    [decision, command.access.userId, comment, id],
  );
  if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Approval changed concurrently");
  const effect = context.approvalEffects.resolve(binding.effectKey);
  const effectResult = await effect.execute({
    transaction: command.transaction,
    claim: {
      action: binding.effectAction,
      challengeNo: typeof body.challengeNo === "string" ? body.challengeNo : `approval-${id}-${binding.objectVersion}`,
      objectId: String(id),
      objectType: binding.objectType,
      objectVersion: binding.objectVersion,
      requestDigest: (await import("node:crypto")).createHash("sha256")
        .update(canonical(finalPayload), "utf8").digest("hex"),
      sessionId: command.access.sessionId ?? 0,
      userId: command.access.userId,
    },
  });
  await audit(command.transaction, command.access, command.request, {
    action: decision, module: "approvals", entityType: String(approval.entityType), entityId: Number(approval.entityId),
    businessNo: String(approval.requestNo), before: approval, after: { decision, comment, effect: effectResult },
  });
  await domainEvent(context, command.transaction, {
    type: "ApprovalDecided", aggregateType: "approval", aggregateId: id,
    payload: { workflowType: workflow, decision },
  });
  return { success: true, approvalId: id, workflowType: workflow, decision, effect: effectResult as never };
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function effect(
  context: DomainRegistrationContext,
  effectType: string,
  execute: ApprovalEffectPort["execute"],
): void {
  context.approvalEffects.register({ effectType, execute });
}

async function effectApproval(transaction: OperationsCommandContext["transaction"], approvalId: number): Promise<Row> {
  const rows = await transaction.query<Row>(
    `SELECT id, entity_id AS entityId, payload_json AS payloadJson, requested_by AS requestedBy
     FROM approval_requests WHERE id = ? LIMIT 1 FOR SHARE`, [approvalId],
  );
  if (rows[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Approval not found");
  return rows[0];
}

export function registerOperationsApprovalEffects(context: DomainRegistrationContext): void {
  effect(context, "r1.user_role_change", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const payload = parsedPayload(approval);
    const roleId = Number(approval.entityId);
    const operation = payload.operation === "revoke" ? "revoke" : "assign";
    const roles = await transaction.query<Row>(
      `SELECT id, status FROM user_roles WHERE id = ? LIMIT 1 FOR UPDATE`, [roleId],
    );
    const role = roles[0];
    const expected = operation === "revoke" ? "active" : "pending";
    if (role === undefined || role.status !== expected) {
      throw new PlatformError(409, "VERSION_CONFLICT", "User role changed before approval effect");
    }
    const next = operation === "revoke"
      ? (claim.action === "approved" ? "revoked" : "active")
      : (claim.action === "approved" ? "active" : "revoked");
    const updated = await transaction.execute(
      `UPDATE user_roles SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
              updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = ?`,
      [next, claim.userId, roleId, expected],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "User role changed concurrently");
    return { userRoleId: roleId, status: next, operation };
  });

  effect(context, "warehouse_transfer", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const id = Number(approval.entityId);
    const updated = await transaction.execute(
      `UPDATE inventory_transfers
       SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending_supply_chain'`,
      [claim.action === "approved" ? "approved" : "rejected", claim.userId, id],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Transfer changed before approval effect");
    return { transferId: id, status: claim.action === "approved" ? "approved" : "rejected" };
  });

  effect(context, "shipment_deviation", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const id = Number(approval.entityId);
    const updated = await transaction.execute(
      `UPDATE delivery_batches SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending_supply_chain'`,
      [claim.action === "approved" ? "approved_to_ship" : "deviation_rejected", id],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Shipment changed before approval effect");
    return { deliveryBatchId: id, status: claim.action === "approved" ? "approved_to_ship" : "deviation_rejected" };
  });

  effect(context, "warehouse_merge", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const payload = parsedPayload(approval);
    const sourceId = integer(payload.sourceId, "sourceId");
    const targetId = integer(payload.targetId, "targetId");
    if (claim.action === "rejected") return { sourceId, targetId, status: "rejected" };
    const warehouses = await transaction.query<Row>(
      `SELECT id, status FROM warehouses WHERE id IN (?, ?) ORDER BY id ASC FOR UPDATE`, [sourceId, targetId],
    );
    if (warehouses.length !== 2 || warehouses.some((row) => row.status !== "active")) {
      throw new PlatformError(409, "VERSION_CONFLICT", "Warehouse state changed before merge");
    }
    const blockers = await transaction.query<Row>(
      `SELECT
         (SELECT COUNT(*) FROM inventory_batches WHERE warehouse_id = ? AND
            (available_quantity + locked_quantity + defective_quantity + pending_inspection_quantity + quarantine_quantity) <> 0) AS inventory,
         (SELECT COUNT(*) FROM inventory_transfers WHERE (from_warehouse_id = ? OR to_warehouse_id = ?)
            AND status IN ('pending_supply_chain','approved','shipped')) AS transfers,
         (SELECT COUNT(*) FROM stocktakes WHERE warehouse_id = ? AND status IN ('first_count','recount','pending_approval')) AS stocktakes`,
      [sourceId, sourceId, sourceId, sourceId],
    );
    if (Object.values(blockers[0] ?? {}).some((value) => Number(value) > 0)) {
      throw new PlatformError(409, "CONFLICT", "Warehouse has blockers and cannot be merged");
    }
    await transaction.execute(
      `UPDATE warehouses SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'active'`,
      [`merged:${targetId}`, sourceId],
    );
    return { sourceId, targetId, status: `merged:${targetId}` };
  });

  effect(context, "stocktake_variance", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const stocktakeId = Number(approval.entityId);
    const tasks = await transaction.query<Row>(
      `SELECT id, stocktake_no AS stocktakeNo, warehouse_id AS warehouseId, status
       FROM stocktakes WHERE id = ? LIMIT 1 FOR UPDATE`, [stocktakeId],
    );
    const task = tasks[0];
    if (task === undefined || task.status !== "pending_approval") {
      throw new PlatformError(409, "VERSION_CONFLICT", "Stocktake changed before approval effect");
    }
    await lockWarehouseFreeze(transaction, Number(task.warehouseId));
    const adjustments = await transaction.query<Row>(
      `SELECT a.id, a.bucket, a.snapshot_quantity AS snapshotQuantity,
              a.counted_quantity AS countedQuantity, a.variance_quantity AS varianceQuantity,
              a.revision, a.generated_batch_no AS generatedBatchNo,
              a.estimated_production_date AS estimatedProductionDate, a.estimated_expiry_date AS estimatedExpiryDate,
              c.id AS countId, c.batch_id AS batchId, c.sku
       FROM stocktake_adjustments a JOIN stocktake_counts c ON c.id = a.stocktake_count_id
       WHERE a.stocktake_id = ? AND a.decision = 'pending' ORDER BY a.id ASC FOR UPDATE`, [stocktakeId],
    );
    for (const adjustment of adjustments) {
      if (claim.action === "approved") {
        if (adjustment.batchId !== null) {
          const columns: Record<string, string> = {
            available: "available_quantity",
            locked: "locked_quantity",
            defective: "defective_quantity",
            pending_inspection: "pending_inspection_quantity",
          };
          const column = columns[String(adjustment.bucket)];
          if (column === undefined) throw new PlatformError(409, "CONFLICT", "Stocktake adjustment bucket is invalid");
          const updated = await transaction.execute(
            `UPDATE inventory_batches
             SET ${column} = ?, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND ${column} = ?`,
            [adjustment.countedQuantity, adjustment.batchId, adjustment.snapshotQuantity],
          );
          if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Stocktake bucket changed after snapshot");
        } else {
          throw new PlatformError(409, "CONFLICT", "Unbound stocktake targets require a separate approved creation workflow");
        }
        await transaction.execute(
          `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?)`,
          [task.warehouseId, adjustment.sku, `stocktake_adjustment_${adjustment.bucket}`,
           adjustment.varianceQuantity, `stocktake:${stocktakeId}:adjustment:${adjustment.id}:revision:${adjustment.revision}`, claim.userId],
        );
      }
      await transaction.execute(
        `UPDATE stocktake_adjustments
         SET decision = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND decision = 'pending'`, [claim.action, claim.userId, adjustment.id],
      );
    }
    await transaction.execute(
      `UPDATE stocktakes SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending_approval'`,
      [claim.action === "approved" ? "completed" : "recount", stocktakeId],
    );
    return { stocktakeId, adjustmentCount: adjustments.length, status: claim.action === "approved" ? "completed" : "recount" };
  });

  effect(context, "production_variance", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    const reportId = Number(approval.entityId);
    const payload = parsedPayload(approval);
    const rows = await transaction.query<Row>(
      `SELECT r.id, r.execution_order_id AS executionOrderId,
              r.actual_finished_quantity AS actualFinishedQuantity,
              eo.execution_no AS executionNo, eo.planned_quantity AS plannedQuantity,
              eo.factory_id AS factoryId, eo.status, oi.sku
       FROM production_reports r JOIN execution_orders eo ON eo.id = r.execution_order_id
       JOIN order_items oi ON oi.id = eo.order_item_id
       WHERE r.id = ? LIMIT 1 FOR UPDATE`, [reportId],
    );
    const report = rows[0];
    if (report === undefined || report.status !== "variance_pending") {
      throw new PlatformError(409, "VERSION_CONFLICT", "Production report changed before approval effect");
    }
    const overproduction = payload.overproduction === true;
    const accepted = claim.action === "approved"
      ? Number(report.actualFinishedQuantity)
      : Math.min(Number(report.actualFinishedQuantity), Number(report.plannedQuantity));
    const factoryOwned = claim.action === "rejected" && overproduction
      ? Math.max(0, Number(report.actualFinishedQuantity) - Number(report.plannedQuantity)) : 0;
    await transaction.execute(
      `UPDATE production_reports
       SET result = ?, company_inventory_quantity = ?, factory_owned_quantity = ?,
           reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [claim.action === "approved" ? "approved" : overproduction ? "rejected_factory_owned" : "rejected",
       accepted, factoryOwned, claim.userId, reportId],
    );
    await transaction.execute(
      `UPDATE production_material_lines SET deviation_status = ?, reserved_quantity = 0, updated_at = CURRENT_TIMESTAMP(3)
       WHERE execution_order_id = ?`, [claim.action, report.executionOrderId],
    );
    await transaction.execute(
      `UPDATE execution_orders SET completed_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'variance_pending'`,
      [accepted, claim.action === "approved" ? "completed" : overproduction ? "completed_factory_owned" : "variance_rejected", report.executionOrderId],
    );
    if (claim.action === "approved" || overproduction) {
      const warehouses = await transaction.query<Row>(
        `SELECT id FROM warehouses WHERE factory_id = ? AND status = 'active'
         ORDER BY CASE WHEN type = 'factory' THEN 0 ELSE 1 END, id ASC LIMIT 1 FOR SHARE`, [report.factoryId],
      );
      const warehouseId = Number(warehouses[0]?.id);
      if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) throw new PlatformError(409, "CONFLICT", "Factory warehouse unavailable");
      await lockWarehouseFreeze(transaction, warehouseId);
      if (await freezeExists(transaction, warehouseId, String(report.sku))) {
        throw new PlatformError(409, "CONFLICT", "Production warehouse is frozen by a stocktake");
      }
      if (accepted > 0) {
        await transaction.execute(
          `INSERT INTO inventory_batches (
             batch_no, warehouse_id, sku, production_date, inbound_date,
             pending_inspection_quantity, ownership, expiry_status, created_at, updated_at
           ) VALUES (?, ?, ?, CURRENT_DATE(), CURRENT_DATE(), ?, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [`PROD-${report.executionNo}-${reportId}-C`, warehouseId, report.sku, accepted],
        );
        await transaction.execute(
          `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
           VALUES (?, ?, 'inbound_pending_inspection', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
          [warehouseId, report.sku, accepted, `production_report:${reportId}:company`, claim.userId],
        );
      }
      if (factoryOwned > 0) {
        await transaction.execute(
          `INSERT INTO inventory_batches (
             batch_no, warehouse_id, sku, production_date, inbound_date,
             available_quantity, ownership, expiry_status, created_at, updated_at
           ) VALUES (?, ?, ?, CURRENT_DATE(), CURRENT_DATE(), ?, 'factory', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [`PROD-${report.executionNo}-${reportId}-F`, warehouseId, report.sku, factoryOwned],
        );
      }
    }
    return { reportId, executionOrderId: report.executionOrderId, acceptedQuantity: accepted, factoryOwnedQuantity: factoryOwned };
  });

  effect(context, "financial_record_correction", async ({ transaction, claim }) => {
    const approval = await effectApproval(transaction, integer(claim.objectId, "approvalId"));
    if (claim.action === "rejected") return { paymentRecordId: approval.entityId, status: "rejected" };
    const originalId = Number(approval.entityId);
    const payload = parsedPayload(approval);
    const proposedPaymentRequestId = integer(payload.proposedPaymentRequestId, "proposedPaymentRequestId");
    const proposedAmountMinor = integer(payload.proposedAmountMinor, "proposedAmountMinor");
    const proposedPaidAt = string(payload.proposedPaidAt, "proposedPaidAt", 100);
    const proposedBankReference = string(payload.proposedBankReference, "proposedBankReference", 191);
    const originals = await transaction.query<Row>(
      `SELECT id, payment_request_id AS paymentRequestId, amount_minor AS amountMinor,
              paid_at AS paidAt, bank_reference AS bankReference, record_type AS recordType,
              invoice_exception_id AS invoiceExceptionId
       FROM payment_records WHERE id = ? LIMIT 1 FOR UPDATE`, [originalId],
    );
    const original = originals[0];
    if (original === undefined || !["payment", "refund"].includes(String(original.recordType))) {
      throw new PlatformError(409, "CONFLICT", "Original financial record changed");
    }
    const related = await transaction.query<Row>(
      `SELECT id, record_type AS recordType, reverses_payment_record_id AS reversesId,
              corrects_payment_record_id AS correctsId
       FROM payment_records
       WHERE reverses_payment_record_id = ? OR corrects_payment_record_id = ?
       ORDER BY id ASC FOR UPDATE`, [originalId, originalId],
    );
    if (related.some((row) =>
      (row.reversesId !== null && row.recordType !== "reversal") ||
      (row.correctsId !== null && row.recordType !== "correction"))) {
      throw new PlatformError(409, "CONFLICT", "Stored financial correction relationship is invalid");
    }
    if (related.length > 0) throw new PlatformError(409, "CONFLICT", "Financial record was already corrected");
    const requestIds = [...new Set([Number(original.paymentRequestId), proposedPaymentRequestId])].sort((a, b) => a - b);
    const requests = new Map<number, Row>();
    for (const id of requestIds) {
      const rows = await transaction.query<Row>(
        `SELECT id, total_amount_minor AS totalAmountMinor,
                invoice_covered_amount_minor AS invoiceCoveredAmountMinor,
                paid_at AS paidAt, status
         FROM factory_payment_requests WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
      );
      if (rows[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Correction payment request not found");
      requests.set(id, rows[0]);
    }
    const proposedRequest = requests.get(proposedPaymentRequestId)!;
    if (original.recordType === "payment" &&
        (Number(proposedRequest.invoiceCoveredAmountMinor) < Number(proposedRequest.totalAmountMinor) ||
         ["waiting_invoice", "invoice_exception_frozen", "failed", "cancelled"].includes(String(proposedRequest.status)))) {
      throw new PlatformError(409, "CONFLICT", "Correction target is not payable");
    }
    let refundException: Row | undefined;
    let refundAllocationRequestIds: Set<number> | undefined;
    if (original.recordType === "refund") {
      if (original.invoiceExceptionId === null) {
        throw new PlatformError(409, "CONFLICT", "Refund correction has no invoice exception");
      }
      const exceptions = await transaction.query<Row>(
        `SELECT e.id, e.invoice_id AS invoiceId,
                e.affected_amount_minor AS affectedAmountMinor,
                e.replacement_covered_amount_minor AS replacementCoveredAmountMinor,
                e.refunded_amount_minor AS refundedAmountMinor, e.status
         FROM invoice_exceptions e WHERE e.id = ? LIMIT 1 FOR UPDATE`, [original.invoiceExceptionId],
      );
      refundException = exceptions[0];
      if (refundException === undefined) throw new PlatformError(404, "NOT_FOUND", "Refund exception not found");
      const allocations = await transaction.query<Row>(
        `SELECT payment_request_id AS paymentRequestId
         FROM invoice_payment_allocations
         WHERE invoice_id = ? AND status IN ('active', 'frozen')
         ORDER BY payment_request_id ASC FOR UPDATE`, [refundException.invoiceId],
      );
      refundAllocationRequestIds = new Set(allocations.map((row) => Number(row.paymentRequestId)));
      if (!refundAllocationRequestIds.has(Number(original.paymentRequestId)) ||
          !refundAllocationRequestIds.has(proposedPaymentRequestId)) {
        throw new PlatformError(409, "CONFLICT", "Refund correction request is not allocated to the exception invoice");
      }
    }
    try {
      await transaction.execute(
        `INSERT INTO r3_business_keys (key_type, key_value, aggregate_id, created_at)
         VALUES ('correction', ?, ?, CURRENT_TIMESTAMP(3))`, [proposedBankReference, String(originalId)],
      );
    } catch {
      throw new PlatformError(409, "CONFLICT", "Correction bank reference already exists");
    }
    await transaction.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         reverses_payment_record_id, invoice_exception_id, recorded_by, reviewed_by,
         review_status, created_at, updated_at
       ) VALUES (?, ?, CURRENT_TIMESTAMP(3), ?, 'reversal', ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [original.paymentRequestId, -Number(original.amountMinor), `reversal:${original.bankReference}`, originalId,
       original.invoiceExceptionId, approval.requestedBy, claim.userId],
    );
    await transaction.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         corrects_payment_record_id, invoice_exception_id, recorded_by, reviewed_by,
         review_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'correction', ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [proposedPaymentRequestId, proposedAmountMinor, proposedPaidAt, proposedBankReference, originalId,
       original.invoiceExceptionId, approval.requestedBy, claim.userId],
    );
    for (const id of requestIds) {
      const request = requests.get(id)!;
      const ledger = await transaction.query<Row>(
        `SELECT amount_minor AS amountMinor, record_type AS recordType,
                invoice_exception_id AS invoiceExceptionId
         FROM payment_records WHERE payment_request_id = ? ORDER BY id ASC FOR UPDATE`, [id],
      );
      const net = ledger.reduce((sum, row) => {
        const amount = Number(row.amountMinor);
        if (!Number.isSafeInteger(amount)) throw new PlatformError(409, "CONFLICT", "Correction ledger is invalid");
        // Exception remediation is a separate refund projection. It never
        // reopens or inflates the normal paid projection.
        return row.invoiceExceptionId === null ? sum + amount : sum;
      }, 0);
      if (net < 0 || net > Number(request.totalAmountMinor)) {
        throw new PlatformError(409, "CONFLICT", "Correction would violate the payable ledger");
      }
      const projectedStatus = net === Number(request.totalAmountMinor) ? "paid" : net > 0 ? "partially_paid" : "generated";
      const updated = await transaction.execute(
        `UPDATE factory_payment_requests SET status = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = ?`,
        [projectedStatus, projectedStatus === "paid"
          ? (original.recordType === "refund" ? request.paidAt : id === proposedPaymentRequestId ? proposedPaidAt : request.paidAt)
          : null, id, request.status],
      );
      if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Payment request changed concurrently");
    }
    if (refundException !== undefined && refundAllocationRequestIds !== undefined) {
      const refundLedger = await transaction.query<Row>(
        `SELECT payment_request_id AS paymentRequestId, amount_minor AS amountMinor,
                record_type AS recordType, invoice_exception_id AS invoiceExceptionId
         FROM payment_records WHERE invoice_exception_id = ? ORDER BY id ASC FOR UPDATE`, [refundException.id],
      );
      let corrected = 0;
      for (const row of refundLedger) {
        const amount = Number(row.amountMinor);
        const type = String(row.recordType);
        if (!refundAllocationRequestIds.has(Number(row.paymentRequestId)) || !Number.isSafeInteger(amount) ||
            !["refund", "reversal", "correction"].includes(type) ||
            (type === "reversal" ? amount >= 0 : amount <= 0)) {
          throw new PlatformError(409, "CONFLICT", "Refund correction ledger is invalid");
        }
        corrected += amount;
        if (!Number.isSafeInteger(corrected)) throw new PlatformError(409, "CONFLICT", "Refund correction ledger exceeds safe bounds");
      }
      if (corrected < 0 || corrected + Number(refundException.replacementCoveredAmountMinor) > Number(refundException.affectedAmountMinor)) {
        throw new PlatformError(409, "CONFLICT", "Correction would violate remediation bounds");
      }
      const resolved = corrected + Number(refundException.replacementCoveredAmountMinor) === Number(refundException.affectedAmountMinor);
      const projected = await transaction.execute(
        `UPDATE invoice_exceptions SET refunded_amount_minor = ?, status = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = ? AND refunded_amount_minor = ?`,
        [corrected, resolved ? "resolved" : "awaiting_remediation", resolved ? new Date().toISOString() : null,
         refundException.id, refundException.status, refundException.refundedAmountMinor],
      );
      if (projected.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Refund exception changed concurrently");
    }
    return { paymentRecordId: originalId, status: "corrected", proposedPaymentRequestId, proposedAmountMinor };
  });
}
