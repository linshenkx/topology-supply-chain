import { createAuditWriter } from "../../infrastructure/audit.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import type { ApprovalClaim, ApprovalEffectContext } from "../../platform/approvals.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { createReminder } from "../notifications/support.js";
import { supplierSkuTargetHash } from "../suppliers/writes.js";
import { conflict, domainEvent, missing, type DataRow } from "../../platform/supply-support.js";

const EFFECT_TYPES = [
  "supplier_onboarding",
  "supplier_sku_change",
  "supplier_price_change",
  "sku_verification",
  "bom_version",
  "purchase_plan_version",
  "purchase_plan_deviation",
  "purchase_plan_factory_exception",
  "purchase_order_factory_exception",
] as const;

type EffectType = (typeof EFFECT_TYPES)[number];

interface ApprovalRow extends DataRow {
  entityId: number;
  entityType: string;
  id: number;
  payloadJson: string;
  requestNo: string;
  requestedBy: number;
  workflowType: string;
}

function decision(claim: ApprovalClaim): "approved" | "rejected" {
  if (claim.action.endsWith(".approve") || claim.action === "approve") return "approved";
  if (claim.action.endsWith(".reject") || claim.action === "reject") return "rejected";
  return conflict("Approval action is not supported");
}

async function authorizedReviewer(transaction: QueryExecutor, userId: number): Promise<void> {
  const rows = await transaction.query<DataRow>(
    `SELECT u.id FROM users u
     WHERE u.id = ? AND u.account_status = 'active'
       AND (
         u.role = 'supply_chain' OR EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = u.id AND ur.role_code IN ('admin','supply_chain')
             AND ur.status = 'active' AND ur.effective_from <= CURRENT_DATE()
             AND (ur.effective_to IS NULL OR ur.effective_to >= CURRENT_DATE())
         )
       )
     LIMIT 1 FOR SHARE`,
    [userId],
  );
  if (rows[0] === undefined) return conflict("Approval reviewer role is not authorized");
}

function payload(value: string): unknown {
  try { return JSON.parse(value); } catch { return conflict("Approval payload is invalid"); }
}

async function applySupplierOnboarding(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const changed = await tx.execute(
    `UPDATE suppliers SET verification_status = ?, status = ?, verified_by = ?,
       verified_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND verification_status = 'pending'`,
    [result, result === "approved" ? "active" : "draft", actor, approval.entityId],
  );
  if (changed.affectedRows !== 1) return conflict("Supplier onboarding target changed concurrently");
}

async function applySupplierSku(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const input = payload(approval.payloadJson) as { targetHash?: unknown; targetVersion?: unknown };
  const targetVersion = Number(input.targetVersion);
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0 || typeof input.targetHash !== "string" || !/^[a-f\d]{64}$/u.test(input.targetHash)) {
    return conflict("Supplier-SKU approval target version is invalid");
  }
  const relations = await tx.query<DataRow & {
    dailyCapacity: number | null; effectiveFrom: string; factoryId: number; id: number;
    isPrimary: number | boolean; leadTimeDays: number | null; minimumOrderQuantity: number;
    monthlyCapacity: number | null; packagingMultiple: number; priority: number;
    purchaseUnit: string; requestedBy: number; sku: string; status: string;
    supplierId: number; updatedAt: string;
  }>(
    `SELECT id, factory_id AS factoryId, supplier_id AS supplierId, sku,
            is_primary AS isPrimary, priority,
            minimum_order_quantity AS minimumOrderQuantity,
            packaging_multiple AS packagingMultiple, purchase_unit AS purchaseUnit,
            lead_time_days AS leadTimeDays, daily_capacity AS dailyCapacity,
            monthly_capacity AS monthlyCapacity, effective_from AS effectiveFrom,
            status, requested_by AS requestedBy, updated_at AS updatedAt
     FROM supplier_skus WHERE id = ? LIMIT 1 FOR UPDATE`,
    [approval.entityId],
  );
  const relation = relations[0];
  if (relation === undefined) return missing("Supplier-SKU approval target not found");
  const versions = await tx.query<DataRow & { version: number }>(
    `SELECT version FROM resource_versions
     WHERE resource_type = 'supplier_sku' AND resource_id = ? LIMIT 1 FOR UPDATE`,
    [String(relation.id)],
  );
  if (versions[0]?.version !== targetVersion) return conflict("Supplier-SKU approval target changed concurrently");
  if (supplierSkuTargetHash(relation) !== input.targetHash) return conflict("Supplier-SKU approval target changed concurrently");
  if (result === "approved" && (relation.isPrimary === true || relation.isPrimary === 1)) {
    await tx.execute(
      `UPDATE supplier_skus SET is_primary = 0, updated_at = CURRENT_TIMESTAMP(3)
       WHERE factory_id = ? AND sku = ? AND id <> ? AND is_primary = 1`,
      [relation.factoryId, relation.sku, relation.id],
    );
  }
  const changed = await tx.execute(
    `UPDATE supplier_skus SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'pending' AND updated_at = ?`,
    [result === "approved" ? "active" : "inactive", actor, relation.id, relation.updatedAt],
  );
  if (changed.affectedRows !== 1) return conflict("Supplier-SKU approval target changed concurrently");
  const bumped = await tx.execute(
    `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
     WHERE resource_type = 'supplier_sku' AND resource_id = ? AND version = ?`,
    [String(relation.id), targetVersion],
  );
  if (bumped.affectedRows !== 1) return conflict("Supplier-SKU approval target changed concurrently");
}

async function applySupplierPrice(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const input = payload(approval.payloadJson) as { priceResourceId?: unknown; priceVersion?: unknown };
  const priceVersion = Number(input.priceVersion);
  if (typeof input.priceResourceId !== "string" || input.priceResourceId.length === 0 ||
      !Number.isSafeInteger(priceVersion) || priceVersion <= 0) {
    return conflict("Supplier price approval target version is invalid");
  }
  const changes = await tx.query<DataRow & {
    currentAgreementId: number | null; decision: string; evidenceFileKey: string; id: number;
    proposedEffectiveFrom: string; proposedTaxExcludedMinor: number; proposedTaxIncludedMinor: number;
    proposedTaxRateBps: number; requestedBy: number; sku: string; supplierId: number;
  }>(
    `SELECT id, current_agreement_id AS currentAgreementId, supplier_id AS supplierId, sku,
            proposed_tax_included_minor AS proposedTaxIncludedMinor,
            proposed_tax_excluded_minor AS proposedTaxExcludedMinor,
            proposed_tax_rate_bps AS proposedTaxRateBps,
            proposed_effective_from AS proposedEffectiveFrom, evidence_file_key AS evidenceFileKey,
            requested_by AS requestedBy, decision
     FROM core_price_change_requests WHERE id = ? LIMIT 1 FOR UPDATE`,
    [approval.entityId],
  );
  const change = changes[0];
  if (change === undefined) return missing("Supplier price approval target not found");
  if (change.decision !== "pending") return conflict("Supplier price request already decided");
  if (input.priceResourceId !== `${change.supplierId}:${change.sku}`) return conflict("Supplier price approval target is invalid");
  const versions = await tx.query<DataRow & { version: number }>(
    `SELECT version FROM resource_versions
     WHERE resource_type = 'supplier_price' AND resource_id = ? LIMIT 1 FOR UPDATE`,
    [input.priceResourceId],
  );
  if (versions[0]?.version !== priceVersion) return conflict("Supplier price changed concurrently");
  if (result === "approved") {
    const activeRows = await tx.query<DataRow & { id: number }>(
      `SELECT id FROM core_price_agreements
       WHERE supplier_id = ? AND sku = ? AND status = 'active'
       ORDER BY effective_from DESC, id DESC LIMIT 1 FOR UPDATE`,
      [change.supplierId, change.sku],
    );
    if ((activeRows[0]?.id ?? null) !== change.currentAgreementId) return conflict("Active supplier price changed concurrently");
    if (change.currentAgreementId !== null) {
      const start = new Date(`${change.proposedEffectiveFrom}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 1);
      const retired = await tx.execute(
        `UPDATE core_price_agreements SET effective_to = ?, status = 'inactive', updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'active'`,
        [start.toISOString().slice(0, 10), change.currentAgreementId],
      );
      if (retired.affectedRows !== 1) return conflict("Active supplier price changed concurrently");
    }
    const inserted = await tx.execute(
      `INSERT INTO core_price_agreements (
         supplier_id, sku, currency, unit_price_tax_included_minor,
         unit_price_tax_excluded_minor, tax_rate_bps, effective_from, status,
         maintained_by, created_at, updated_at
       ) VALUES (?, ?, 'CNY', ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [change.supplierId, change.sku, change.proposedTaxIncludedMinor, change.proposedTaxExcludedMinor, change.proposedTaxRateBps, change.proposedEffectiveFrom, change.requestedBy],
    );
    if (inserted.affectedRows !== 1) throw new Error("Approved price write failed");
    const bumped = await tx.execute(
      `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
       WHERE resource_type = 'supplier_price' AND resource_id = ? AND version = ?`,
      [input.priceResourceId, priceVersion],
    );
    if (bumped.affectedRows !== 1) return conflict("Supplier price changed concurrently");
  }
  const changed = await tx.execute(
    `UPDATE core_price_change_requests SET decision = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
       review_comment = '', updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND decision = 'pending'`,
    [result, actor, change.id],
  );
  if (changed.affectedRows !== 1) return conflict("Supplier price request changed concurrently");
}

async function applySku(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected"): Promise<void> {
  const changed = await tx.execute(
    `UPDATE skus SET verification_status = ?, status = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND verification_status = 'pending'`,
    [result, result === "approved" ? "active" : "draft", approval.entityId],
  );
  if (changed.affectedRows !== 1) return conflict("SKU approval target changed concurrently");
}

async function applyBom(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const input = payload(approval.payloadJson) as { retireBomIds?: unknown; retirementDate?: unknown };
  if (result === "approved" && typeof input.retirementDate === "string" && Array.isArray(input.retireBomIds)) {
    for (const id of input.retireBomIds) {
      if (Number.isSafeInteger(id) && Number(id) > 0) {
        await tx.execute("UPDATE product_boms SET effective_to = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [input.retirementDate, id]);
      }
    }
  }
  const changed = await tx.execute(
    `UPDATE product_boms SET approval_status = ?, active = ?, reviewed_by = ?,
       reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND approval_status = 'pending'`,
    [result, result === "approved" ? 1 : 0, actor, approval.entityId],
  );
  if (changed.affectedRows !== 1) return conflict("BOM approval target changed concurrently");
}

async function applyPlanVersion(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const dueAt = result === "approved" ? new Date(Date.now() + 3 * 86_400_000).toISOString() : null;
  const changed = await tx.execute(
    `UPDATE purchase_plans SET status = ?, confirmation_due_at = ?, reviewed_by = ?,
       reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'pending_approval'`,
    [result === "approved" ? "awaiting_factory_confirmation" : "draft", dueAt, actor, approval.entityId],
  );
  if (changed.affectedRows !== 1) return conflict("Purchase plan approval target changed concurrently");
  if (dueAt !== null) await createReminder(tx, { reminderType: "purchase_plan_confirmation", entityType: "purchase_plan", entityId: approval.entityId, businessNo: approval.requestNo, dueAt });
}

async function applyPlanDeviation(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected"): Promise<void> {
  const input = payload(approval.payloadJson);
  if (!Array.isArray(input)) return conflict("Purchase plan deviation payload is invalid");
  const planIds = new Set<number>();
  for (const candidate of input) {
    if (typeof candidate !== "object" || candidate === null || !("planItemId" in candidate)) continue;
    const planItemId = Number(candidate.planItemId);
    if (!Number.isSafeInteger(planItemId) || planItemId <= 0) continue;
    const rows = await tx.query<DataRow & { purchasePlanId: number }>(
      "SELECT purchase_plan_id AS purchasePlanId FROM purchase_plan_items WHERE id = ? LIMIT 1 FOR UPDATE",
      [planItemId],
    );
    if (rows[0] === undefined) return missing("Purchase plan deviation item not found");
    planIds.add(rows[0].purchasePlanId);
    if (result === "approved") await tx.execute("UPDATE purchase_plan_items SET completion_status = 'exception_approved', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [planItemId]);
  }
  if (approval.entityType === "purchase_order") {
    const orders = await tx.query<DataRow & { orderNo: string; status: string; updatedAt: string }>(
      `SELECT order_no AS orderNo, status, updated_at AS updatedAt
       FROM purchase_orders WHERE id = ? LIMIT 1 FOR UPDATE`,
      [approval.entityId],
    );
    const order = orders[0];
    if (order === undefined) return missing("Purchase order approval target not found");
    if (order.status !== "pending_approval") return conflict("Purchase order approval target changed concurrently");
    const changed = await tx.execute(
      `UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending_approval' AND updated_at = ?`,
      [result === "approved" ? "factory_confirmation" : "approval_rejected", approval.entityId, order.updatedAt],
    );
    if (changed.affectedRows !== 1) return conflict("Purchase order approval target changed concurrently");
    if (result === "approved") {
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      await createReminder(tx, { reminderType: "purchase_order_confirmation", entityType: "purchase_order", entityId: approval.entityId, businessNo: order.orderNo, dueAt });
    }
  }
  if (approval.entityType === "purchase_plan") planIds.add(approval.entityId);
  for (const planId of planIds) {
    const incomplete = await tx.query<DataRow>(
      `SELECT id FROM purchase_plan_items
       WHERE purchase_plan_id = ? AND completion_status NOT IN ('within_tolerance','exception_approved')
       LIMIT 1 FOR SHARE`,
      [planId],
    );
    const plans = await tx.query<DataRow & { status: string; updatedAt: string }>(
      "SELECT status, updated_at AS updatedAt FROM purchase_plans WHERE id = ? LIMIT 1 FOR UPDATE",
      [planId],
    );
    const plan = plans[0];
    if (plan === undefined) return missing("Purchase plan approval target not found");
    if (plan.status !== "ordering") return conflict("Purchase plan approval target changed concurrently");
    const changed = await tx.execute(
      `UPDATE purchase_plans SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'ordering' AND updated_at = ?`,
      [incomplete[0] === undefined ? "ordered_complete" : "ordering", planId, plan.updatedAt],
    );
    if (changed.affectedRows !== 1) return conflict("Purchase plan approval target changed concurrently");
  }
}

async function applyPlanException(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected", actor: number): Promise<void> {
  const responses = await tx.query<DataRow & { factoryId: number; id: number; proposedArrivalDate: string | null; purchasePlanId: number }>(
    `SELECT id, purchase_plan_id AS purchasePlanId, factory_id AS factoryId,
            proposed_arrival_date AS proposedArrivalDate
     FROM factory_plan_responses WHERE id = ? LIMIT 1 FOR UPDATE`,
    [approval.entityId],
  );
  const response = responses[0];
  if (response === undefined) return missing("Factory plan response not found");
  const changed = await tx.execute(
    `UPDATE factory_plan_responses SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
       updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'pending_supply_chain'`,
    [result, actor, response.id],
  );
  if (changed.affectedRows !== 1) return conflict("Factory plan response changed concurrently");
  if (result === "approved") {
    if (response.proposedArrivalDate !== null) await tx.execute("UPDATE purchase_plan_items SET expected_arrival_date = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE purchase_plan_id = ? AND factory_id = ?", [response.proposedArrivalDate, response.purchasePlanId, response.factoryId]);
    await tx.execute("UPDATE purchase_plans SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP(3), reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [actor, response.purchasePlanId]);
  } else {
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await tx.execute("UPDATE purchase_plans SET status = 'awaiting_factory_confirmation', confirmation_due_at = ?, confirmed_at = NULL, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [dueAt, actor, response.purchasePlanId]);
    await createReminder(tx, { reminderType: "purchase_plan_confirmation", entityType: "purchase_plan", entityId: response.purchasePlanId, businessNo: approval.requestNo, dueAt });
  }
}

async function applyOrderException(tx: QueryExecutor, approval: ApprovalRow, result: "approved" | "rejected"): Promise<void> {
  const input = payload(approval.payloadJson) as { proposedDueDate?: unknown };
  if (result === "approved") {
    if (typeof input.proposedDueDate !== "string") return conflict("Purchase order exception date is missing");
    await tx.execute("UPDATE order_items SET due_date = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE purchase_order_id = ?", [input.proposedDueDate, approval.entityId]);
    await tx.execute("UPDATE purchase_orders SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'disputed'", [approval.entityId]);
  } else {
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    await tx.execute("UPDATE purchase_orders SET status = 'factory_confirmation', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'disputed'", [approval.entityId]);
    await createReminder(tx, { reminderType: "purchase_order_confirmation", entityType: "purchase_order", entityId: approval.entityId, businessNo: approval.requestNo, dueAt });
  }
}

async function executeEffect(
  context: DomainRegistrationContext,
  effectType: EffectType,
  effect: ApprovalEffectContext,
): Promise<{ decision: string; entityId: number; workflowType: string }> {
  const tx = effect.transaction;
  const claim = effect.claim;
  const result = decision(claim);
  if (claim.objectType !== "r2:approval_request" || !/^[1-9]\d*$/u.test(claim.objectId)) return conflict("Approval claim object is invalid");
  await authorizedReviewer(tx, claim.userId);
  const approvals = await tx.query<ApprovalRow>(
    `SELECT id, request_no AS requestNo, workflow_type AS workflowType,
            entity_type AS entityType, entity_id AS entityId, payload_json AS payloadJson,
            requested_by AS requestedBy
     FROM approval_requests WHERE id = ? LIMIT 1 FOR UPDATE`,
    [Number(claim.objectId)],
  );
  const approval = approvals[0];
  if (approval === undefined || approval.workflowType !== effectType) return missing("Approval request not found for this domain effect");
  if (approval.requestedBy === claim.userId) return conflict("Requester cannot review the same approval");
  const versions = await tx.query<DataRow & { version: number }>(
    `SELECT version FROM resource_versions
     WHERE resource_type = 'approval_request' AND resource_id = ? LIMIT 1 FOR UPDATE`,
    [claim.objectId],
  );
  if (versions[0]?.version !== claim.objectVersion) return conflict("Approval version changed concurrently");

  switch (effectType) {
    case "supplier_onboarding": await applySupplierOnboarding(tx, approval, result, claim.userId); break;
    case "supplier_sku_change": await applySupplierSku(tx, approval, result, claim.userId); break;
    case "supplier_price_change": await applySupplierPrice(tx, approval, result, claim.userId); break;
    case "sku_verification": await applySku(tx, approval, result); break;
    case "bom_version": await applyBom(tx, approval, result, claim.userId); break;
    case "purchase_plan_version": await applyPlanVersion(tx, approval, result, claim.userId); break;
    case "purchase_plan_deviation": await applyPlanDeviation(tx, approval, result); break;
    case "purchase_plan_factory_exception": await applyPlanException(tx, approval, result, claim.userId); break;
    case "purchase_order_factory_exception": await applyOrderException(tx, approval, result); break;
  }
  const bumped = await tx.execute(
    `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
     WHERE resource_type = 'approval_request' AND resource_id = ? AND version = ?`,
    [claim.objectId, claim.objectVersion],
  );
  if (bumped.affectedRows !== 1) return conflict("Approval effect changed concurrently");
  await createAuditWriter({ database: tx })({
    access: { localPreview: false, userId: claim.userId },
    action: result === "approved" ? "apply_approval" : "apply_rejection",
    module: "r2_approval_effects",
    entityType: approval.entityType,
    entityId: approval.entityId,
    businessNo: approval.requestNo,
    after: { approvalId: approval.id, workflowType: effectType, decision: result, objectVersion: claim.objectVersion + 1 },
  });
  await domainEvent(context, tx, { entityId: approval.entityId, entityType: approval.entityType, eventType: result === "approved" ? "ApprovalEffectApplied" : "RejectionEffectApplied", idempotencyKey: claim.challengeNo, recipient: { kind: "user", userId: approval.requestedBy }, data: { approvalId: approval.id, workflowType: effectType } });
  return { decision: result, entityId: approval.entityId, workflowType: effectType };
}

export function registerSupplyApprovalEffects(context: DomainRegistrationContext): void {
  for (const effectType of EFFECT_TYPES) {
    context.approvalEffects.register({
      effectType: `r2.${effectType}`,
      execute: (effect) => executeEffect(context, effectType, effect),
    });
  }
  context.approvalPolicy.register("r2:approval_request", {
    evaluate: async (claim) => ({
      allowed: claim.objectVersion > 0 && /^[1-9]\d*$/u.test(claim.objectId) &&
        (claim.action.endsWith(".approve") || claim.action.endsWith(".reject") || claim.action === "approve" || claim.action === "reject"),
      reasonCode: "R2_APPROVAL_CLAIM_POLICY",
    }),
  });
}
