import type { FastifyRequest } from "fastify";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import type { AccessContext } from "../auth/index.js";
import { executeSupplyCommand } from "../../platform/supply-command.js";
import { approvalNotification, createApproval } from "../approvals/support.js";
import { requireFile } from "../files/support.js";
import { createReminder } from "../notifications/support.js";
import { planItems, type PlanRow } from "./support.js";
import {
  audit,
  bad,
  conflict,
  date,
  domainEvent,
  expectedTimestamp,
  forbidden,
  insertId,
  isInternal,
  jsonValue,
  missing,
  objectBody,
  optionalText,
  positiveInteger,
  requireFactoryBinding,
  text,
  type DataRow,
} from "../../platform/supply-support.js";

interface BomRow extends DataRow {
  active: number | boolean;
  approvalStatus: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  finishedSku: string;
  id: number;
  version: string;
}
interface SkuRow extends DataRow {
  code: string;
  itemType: string;
  purchaseOverToleranceBps: number;
  purchaseUnderToleranceBps: number;
}
export async function createPurchasePlan(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  if (!isInternal(access)) return forbidden();
  const body = objectBody(raw);
  const planNo = text(body.planNo, 191);
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 1_000) return bad("Purchase plan items required");
  const inputItems = body.items.map(objectBody);
  const sourceFileKey = optionalText(body.sourceFileKey, 1_000);
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "purchase-plans.create",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: 201,
    run: async ({ idempotencyKey, transaction }) => {
      if (sourceFileKey !== null) {
        await requireFile(
          transaction,
          access,
          { objectKey: sourceFileKey },
          ["import", "import_source"],
          { entityType: "import_upload", entityIds: [access.userId] },
        );
      }
      const previousRows = await transaction.query<PlanRow>(
        `SELECT id, plan_no AS planNo, version, status, confirmation_due_at AS confirmationDueAt,
                updated_at AS updatedAt
         FROM purchase_plans WHERE plan_no = ? ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [planNo],
      );
      const previous = previousRows[0];
      const version = (previous?.version ?? 0) + 1;
      const approvalRequired = previous !== undefined;
      const prepared: Array<Record<string, unknown>> = [];
      const summaryKeys = new Set<string>();
      for (const item of inputItems) {
        const expectedArrivalDate = date(item.expectedArrivalDate);
        const factoryId = positiveInteger(item.factoryId);
        const warehouseId = positiveInteger(item.warehouseId);
        const sku = text(item.sku, 191);
        const productName = text(item.productName, 500);
        const bomId = positiveInteger(item.bomId);
        const plannedQuantity = positiveInteger(item.plannedQuantity);
        const key = `${expectedArrivalDate}:${factoryId}:${warehouseId}:${sku}`;
        if (summaryKeys.has(key)) return conflict("Purchase plan summary key is duplicated");
        summaryKeys.add(key);
        const scopeRows = await transaction.query<DataRow>(
          `SELECT f.id AS factoryId, w.id AS warehouseId
           FROM factories f JOIN warehouses w ON w.id = ? AND w.factory_id = f.id
           WHERE f.id = ? AND f.status = 'active' AND w.status = 'active' LIMIT 1 FOR SHARE`,
          [warehouseId, factoryId],
        );
        if (scopeRows[0] === undefined) return missing("Active factory/warehouse binding not found");
        const bomRows = await transaction.query<BomRow>(
          `SELECT id, finished_sku AS finishedSku, version, effective_from AS effectiveFrom,
                  effective_to AS effectiveTo, approval_status AS approvalStatus, active
           FROM product_boms WHERE id = ? LIMIT 1 FOR SHARE`,
          [bomId],
        );
        const bom = bomRows[0];
        if (bom === undefined || bom.finishedSku !== sku || bom.approvalStatus !== "approved" || !(bom.active === true || bom.active === 1) || expectedArrivalDate < bom.effectiveFrom || (bom.effectiveTo !== null && expectedArrivalDate > bom.effectiveTo)) return bad(`Approved active BOM required for SKU ${sku}`);
        const skuRows = await transaction.query<SkuRow>(
          `SELECT code, item_type AS itemType, purchase_over_tolerance_bps AS purchaseOverToleranceBps,
                  purchase_under_tolerance_bps AS purchaseUnderToleranceBps
           FROM skus WHERE code = ? AND status = 'active' LIMIT 1 FOR SHARE`,
          [sku],
        );
        const skuRow = skuRows[0];
        if (skuRow === undefined || skuRow.itemType !== "finished") return bad(`Active finished SKU required: ${sku}`);
        prepared.push({ expectedArrivalDate, factoryId, warehouseId, sku, productName, bomId, plannedQuantity, overToleranceBps: skuRow.purchaseOverToleranceBps, underToleranceBps: skuRow.purchaseUnderToleranceBps });
      }
      const confirmationDueAt = approvalRequired ? null : new Date(Date.now() + 3 * 86_400_000).toISOString();
      const planId = await insertId(
        transaction,
        `INSERT INTO purchase_plans (
           plan_no, version, source, source_file_key, status, confirmation_due_at,
           created_by, created_at, updated_at
         ) VALUES (?, ?, 'lingxing_excel', ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [planNo, version, sourceFileKey, approvalRequired ? "pending_approval" : "awaiting_factory_confirmation", confirmationDueAt, access.userId],
      );
      for (const item of prepared) {
        const inserted = await transaction.execute(
          `INSERT INTO purchase_plan_items (
             purchase_plan_id, expected_arrival_date, factory_id, warehouse_id, sku,
             product_name, bom_id, planned_quantity, ordered_quantity,
             over_tolerance_bps, under_tolerance_bps, completion_status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'not_ordered', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [planId, item.expectedArrivalDate, item.factoryId, item.warehouseId, item.sku, item.productName, item.bomId, item.plannedQuantity, item.overToleranceBps, item.underToleranceBps] as never[],
        );
        if (inserted.affectedRows !== 1) throw new Error("Purchase plan item write failed");
      }
      let approvalId: number | undefined;
      if (approvalRequired) {
        approvalId = await createApproval(transaction, { entityId: planId, entityType: "purchase_plan", idempotencyKey, payload: body, requestedBy: access.userId, summary: `${planNo} version ${version}`, workflowType: "purchase_plan_version" });
      } else if (confirmationDueAt !== null) {
        await createReminder(transaction, { reminderType: "purchase_plan_confirmation", entityType: "purchase_plan", entityId: planId, businessNo: planNo, dueAt: confirmationDueAt });
      }
      const plan = { id: planId, planNo, version, sourceFileKey, status: approvalRequired ? "pending_approval" : "awaiting_factory_confirmation", confirmationDueAt };
      await audit(transaction, request, access, { action: "create_version", module: "purchase_plans", entityType: "purchase_plan", entityId: planId, businessNo: planNo, after: { ...plan, items: prepared } });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: planId, entityType: "purchase_plan", eventType: "FactoryConfirmationDue", idempotencyKey, recipient: { kind: "entity_binding", role: "factory", entityType: "purchase_plan", entityId: planId }, data: { planNo, version } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: planId, targetEntityType: "purchase_plan", workflowType: "purchase_plan_version" });
      }
      return { plan, approvalRequired };
    },
  });
}

export async function updatePurchasePlan(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const id = positiveInteger(body.id, "Purchase plan required");
  const expectedUpdatedAt = expectedTimestamp(body.expectedUpdatedAt);
  const finalize = body.action === "finalize_ordering";
  if (finalize) {
    if (!isInternal(access)) return forbidden();
  } else if (!access.roles.includes("factory") || access.factoryId === null) return forbidden("Factory role and binding are required");
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "purchase-plans.update",
    context,
    payload: jsonValue(body),
    request,
    run: async ({ idempotencyKey, transaction }) => {
      const planRows = await transaction.query<PlanRow>(
        `SELECT id, plan_no AS planNo, version, status, confirmation_due_at AS confirmationDueAt,
                updated_at AS updatedAt
         FROM purchase_plans WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id],
      );
      const plan = planRows[0];
      if (plan === undefined) return missing("Purchase plan not found");
      if (plan.updatedAt !== expectedUpdatedAt) return conflict("Purchase plan changed concurrently");
      if (finalize && !["confirmed", "ordering"].includes(plan.status)) {
        return conflict("Purchase plan is not in an orderable state");
      }
      if (!finalize && plan.status !== "awaiting_factory_confirmation") {
        return conflict("Purchase plan does not require factory confirmation");
      }
      const items = await planItems(transaction, id);
      if (items.length === 0) return conflict("Purchase plan has no items");
      if (finalize) {
        const deviations = items.flatMap((item) => {
          const rateBps = Math.round(((item.orderedQuantity - item.plannedQuantity) / item.plannedQuantity) * 10_000);
          return rateBps < -item.underToleranceBps ? [{ planItemId: item.id, sku: item.sku, type: "under_plan", rateBps }] : [];
        });
        for (const item of items) {
          const status = deviations.some((entry) => entry.planItemId === item.id) ? "under_plan_pending" : "within_tolerance";
          const changed = await transaction.execute(
            `UPDATE purchase_plan_items SET completion_status = ?, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND ordered_quantity = ? AND completion_status = ?`,
            [status, item.id, item.orderedQuantity, item.completionStatus],
          );
          if (changed.affectedRows !== 1) return conflict("Purchase plan item changed concurrently");
        }
        const approvalId = deviations.length > 0 ? await createApproval(transaction, { entityId: id, entityType: "purchase_plan", idempotencyKey, payload: deviations, requestedBy: access.userId, summary: `${plan.planNo} has under-plan purchasing`, workflowType: "purchase_plan_deviation" }) : undefined;
        const status = deviations.length > 0 ? "ordering" : "ordered_complete";
        const updated = await transaction.execute(
          `UPDATE purchase_plans SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND status = ? AND updated_at = ?`,
          [status, id, plan.status, expectedUpdatedAt],
        );
        if (updated.affectedRows !== 1) return conflict("Purchase plan changed concurrently");
        await audit(transaction, request, access, { action: "finalize_ordering", module: "purchase_plans", entityType: "purchase_plan", entityId: id, businessNo: plan.planNo, after: { deviations, status } });
        if (approvalId === undefined) {
          await domainEvent(context, transaction, { entityId: id, entityType: "purchase_plan", eventType: "PurchasePlanOrderingFinalized", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { deviationCount: 0 } });
        } else {
          await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: id, targetEntityType: "purchase_plan", workflowType: "purchase_plan_deviation" });
        }
        return { success: true, approvalRequired: deviations.length > 0, deviations, status };
      }

      const factoryId = access.factoryId!;
      requireFactoryBinding(access, factoryId);
      if (!items.some((item) => item.factoryId === factoryId)) return forbidden("Purchase plan is not bound to this factory");
      if (items.some((item) => item.factoryId !== factoryId)) return conflict("Multi-factory plan response requires the approved factory-subaggregate model");
      const decision = text(body.decision, 20);
      if (decision !== "confirmed" && decision !== "unable") return bad("Invalid factory decision");
      const expectedStartDate = date(body.expectedStartDate);
      const expectedFinishDate = date(body.expectedFinishDate);
      if (expectedFinishDate < expectedStartDate) return bad("Finish date cannot precede start date");
      const proposedArrivalDate = decision === "unable" ? date(body.proposedArrivalDate) : optionalText(body.proposedArrivalDate, 10);
      const reason = decision === "unable" ? text(body.reason, 2_000) : (optionalText(body.reason, 2_000) ?? "");
      const responseId = await insertId(
        transaction,
        `INSERT INTO factory_plan_responses (
           purchase_plan_id, factory_id, decision, expected_start_date, expected_finish_date,
           proposed_arrival_date, reason, status, responded_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [id, factoryId, decision, expectedStartDate, expectedFinishDate, proposedArrivalDate, reason, decision === "confirmed" ? "accepted" : "pending_supply_chain", access.userId],
      );
      const status = decision === "confirmed" ? "confirmed" : "disputed";
      const updated = await transaction.execute(
        `UPDATE purchase_plans SET status = ?, confirmed_at = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'awaiting_factory_confirmation' AND updated_at = ?`,
        [status, decision === "confirmed" ? new Date().toISOString() : null, id, expectedUpdatedAt],
      );
      if (updated.affectedRows !== 1) return conflict("Purchase plan changed concurrently");
      const approvalId = decision === "unable" ? await createApproval(transaction, { entityId: responseId, entityType: "factory_plan_response", idempotencyKey, payload: { planId: id, decision, expectedStartDate, expectedFinishDate, proposedArrivalDate, reason }, requestedBy: access.userId, summary: `${plan.planNo} factory cannot meet plan`, workflowType: "purchase_plan_factory_exception" }) : undefined;
      const response = { id: responseId, purchasePlanId: id, factoryId, decision, expectedStartDate, expectedFinishDate, proposedArrivalDate, reason, status: decision === "confirmed" ? "accepted" : "pending_supply_chain" };
      await audit(transaction, request, access, { action: decision === "confirmed" ? "factory_confirm" : "factory_dispute", module: "purchase_plans", entityType: "purchase_plan", entityId: id, businessNo: plan.planNo, after: response });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: id, entityType: "purchase_plan", eventType: "FactoryPlanConfirmed", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { factoryId, responseId } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: responseId, targetEntityType: "factory_plan_response", workflowType: "purchase_plan_factory_exception" });
      }
      return { success: true, response };
    },
  });
}
