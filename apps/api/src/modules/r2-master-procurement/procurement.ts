import type { FastifyRequest } from "fastify";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import type { AccessContext } from "../auth/index.js";
import { executeR2Command } from "./command.js";
import {
  approvalNotification,
  audit,
  bad,
  conflict,
  createApproval,
  createReminder,
  date,
  domainEvent,
  forbidden,
  insertId,
  isInternal,
  jsonValue,
  missing,
  nonNegativeInteger,
  objectBody,
  optionalText,
  positiveInteger,
  requireFactoryBinding,
  requireFile,
  text,
  type DataRow,
} from "./shared.js";

interface PlanRow extends DataRow {
  confirmationDueAt: string | null;
  id: number;
  planNo: string;
  status: string;
  updatedAt: string;
  version: number;
}

interface PlanItemRow extends DataRow {
  bomId: number;
  completionStatus: string;
  factoryId: number;
  id: number;
  orderedQuantity: number;
  overToleranceBps: number;
  plannedQuantity: number;
  purchasePlanId: number;
  sku: string;
  underToleranceBps: number;
  warehouseId: number;
}

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

function expectedTimestamp(value: unknown): string {
  const timestamp = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z)?$/u.test(timestamp)) return bad("Expected resource timestamp required");
  return timestamp;
}

async function planItems(transaction: import("../../infrastructure/database.js").QueryExecutor, planId: number): Promise<readonly PlanItemRow[]> {
  return transaction.query<PlanItemRow>(
    `SELECT id, purchase_plan_id AS purchasePlanId, factory_id AS factoryId,
            warehouse_id AS warehouseId, sku, bom_id AS bomId,
            planned_quantity AS plannedQuantity, ordered_quantity AS orderedQuantity,
            over_tolerance_bps AS overToleranceBps, under_tolerance_bps AS underToleranceBps,
            completion_status AS completionStatus
     FROM purchase_plan_items WHERE purchase_plan_id = ? ORDER BY id FOR UPDATE`,
    [planId],
  );
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
  return executeR2Command({
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
  return executeR2Command({
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

interface SupplierRow extends DataRow {
  id: number;
  managedByFactoryId: number | null;
  tier: number | null;
}

interface PriceRow extends DataRow {
  id: number;
  taxRateBps: number;
  unitPriceTaxExcludedMinor: number;
  unitPriceTaxIncludedMinor: number;
}

interface OrderRow extends DataRow {
  id: number;
  orderNo: string;
  status: string;
  updatedAt: string;
}

export async function createPurchaseOrder(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  if (!isInternal(access)) return forbidden();
  const body = objectBody(raw);
  const orderNo = text(body.orderNo, 191);
  const orderDate = date(body.orderDate);
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 1_000) return bad("Purchase order items required");
  const inputItems = body.items.map(objectBody);
  const sourceFileKey = optionalText(body.sourceFileKey, 1_000);
  return executeR2Command({
    actorScope: `user:${access.userId}`,
    command: "purchase-orders.create",
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
      const duplicate = await transaction.query<DataRow>("SELECT id FROM purchase_orders WHERE order_no = ? LIMIT 1 FOR UPDATE", [orderNo]);
      if (duplicate[0] !== undefined) return conflict("Purchase order number already exists");
      const prepared: Array<Record<string, unknown> & { planItem: PlanItemRow }> = [];
      const lockedPlans = new Map<number, PlanRow>();
      const itemKeys = new Set<string>();
      const orderedInputs = [...inputItems].sort((left, right) => positiveInteger(left.planItemId) - positiveInteger(right.planItemId));
      for (const item of orderedInputs) {
        const planItemId = positiveInteger(item.planItemId);
        const supplierId = positiveInteger(item.supplierId, "Supplier is required");
        const quantity = positiveInteger(item.quantity);
        const dueDate = date(item.dueDate);
        const planRows = await transaction.query<PlanItemRow>(
          `SELECT id, purchase_plan_id AS purchasePlanId, factory_id AS factoryId,
                  warehouse_id AS warehouseId, sku, bom_id AS bomId,
                  planned_quantity AS plannedQuantity, ordered_quantity AS orderedQuantity,
                  over_tolerance_bps AS overToleranceBps, under_tolerance_bps AS underToleranceBps,
                  completion_status AS completionStatus
           FROM purchase_plan_items WHERE id = ? LIMIT 1 FOR UPDATE`,
          [planItemId],
        );
        const planItem = planRows[0];
        if (planItem === undefined) return missing(`Purchase plan item not found: ${planItemId}`);
        let parentPlan = lockedPlans.get(planItem.purchasePlanId);
        if (parentPlan === undefined) {
          const parentRows = await transaction.query<PlanRow>(
            `SELECT id, plan_no AS planNo, version, status,
                    confirmation_due_at AS confirmationDueAt, updated_at AS updatedAt
             FROM purchase_plans WHERE id = ? LIMIT 1 FOR UPDATE`,
            [planItem.purchasePlanId],
          );
          parentPlan = parentRows[0];
          if (parentPlan === undefined) return missing("Purchase plan not found for order item");
          const latestRows = await transaction.query<PlanRow>(
            `SELECT id, plan_no AS planNo, version, status,
                    confirmation_due_at AS confirmationDueAt, updated_at AS updatedAt
             FROM purchase_plans WHERE plan_no = ? ORDER BY version DESC LIMIT 1 FOR UPDATE`,
            [parentPlan.planNo],
          );
          const latest = latestRows[0];
          if (latest === undefined || latest.id !== parentPlan.id || latest.version !== parentPlan.version) {
            return conflict("Purchase order requires the latest purchase-plan version");
          }
          if (!["confirmed", "ordering"].includes(parentPlan.status)) {
            return conflict("Purchase order requires an approved orderable purchase plan");
          }
          lockedPlans.set(parentPlan.id, parentPlan);
        }
        const sku = text(item.sku, 191);
        if (sku !== planItem.sku) return conflict("Purchase order SKU does not match the plan item");
        const productName = text(item.productName, 500);
        const itemType = text(item.itemType, 30);
        if (!["finished", "auxiliary", "component"].includes(itemType)) return bad("Invalid purchase item type");
        const key = `${sku}:${supplierId}`;
        if (itemKeys.has(key)) return conflict("Purchase order supplier/SKU line is duplicated");
        itemKeys.add(key);
        const supplierRows = await transaction.query<SupplierRow>("SELECT id, tier, managed_by_factory_id AS managedByFactoryId FROM suppliers WHERE id = ? AND status = 'active' LIMIT 1 FOR SHARE", [supplierId]);
        if (supplierRows[0] === undefined) return missing("Active supplier not found");
        const relations = await transaction.query<DataRow>(
          `SELECT id FROM supplier_skus
           WHERE factory_id = ? AND supplier_id = ? AND sku = ? AND status = 'active'
             AND effective_from <= ? LIMIT 1 FOR SHARE`,
          [planItem.factoryId, supplierId, sku, orderDate],
        );
        if (relations[0] === undefined) return conflict("Active supplier-SKU relation not found for the plan factory");
        const prices = await transaction.query<PriceRow>(
          `SELECT id, unit_price_tax_included_minor AS unitPriceTaxIncludedMinor,
                  unit_price_tax_excluded_minor AS unitPriceTaxExcludedMinor, tax_rate_bps AS taxRateBps
           FROM core_price_agreements
           WHERE supplier_id = ? AND sku = ? AND status = 'active'
             AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
           ORDER BY effective_from DESC, id DESC LIMIT 1 FOR SHARE`,
          [supplierId, sku, orderDate, orderDate],
        );
        const price = prices[0];
        if (price === undefined) return conflict("Approved effective supplier price not found");
        if (item.unitPriceTaxIncludedMinor !== undefined && nonNegativeInteger(item.unitPriceTaxIncludedMinor) !== price.unitPriceTaxIncludedMinor) return conflict("Client price does not match the authoritative agreement");
        const cumulative = planItem.orderedQuantity + quantity;
        if (!Number.isSafeInteger(cumulative)) return bad("Purchase quantity overflow");
        const rateBps = Math.round(((cumulative - planItem.plannedQuantity) / planItem.plannedQuantity) * 10_000);
        prepared.push({ planItem, planItemId, supplierId, quantity, dueDate, sku, productName, itemType, priceAgreementId: price.id, unitPriceTaxIncludedMinor: price.unitPriceTaxIncludedMinor, unitPriceTaxExcludedMinor: price.unitPriceTaxExcludedMinor, taxRateBps: price.taxRateBps, amountTaxIncludedMinor: price.unitPriceTaxIncludedMinor * quantity, cumulative, rateBps });
      }
      const total = prepared.reduce((sum, item) => sum + Number(item.amountTaxIncludedMinor), 0);
      if (!Number.isSafeInteger(total)) return bad("Purchase order amount overflow");
      const approvalRequired = prepared.some((item) => Number(item.rateBps) > item.planItem.overToleranceBps);
      const initialStatus = approvalRequired ? "pending_approval" : "factory_confirmation";
      const orderId = await insertId(
        transaction,
        `INSERT INTO purchase_orders (
           order_no, source, source_file_key, status, order_date, total_tax_included_minor,
           created_at, updated_at
         ) VALUES (?, 'lingxing_excel', ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [orderNo, sourceFileKey, initialStatus, orderDate, total],
      );
      const deviations: Array<{ planItemId: number; rateBps: number; sku: string; type: string }> = [];
      const affectedPlanIds = new Set<number>();
      for (const item of prepared) {
        const planItem = item.planItem;
        const orderItemId = await insertId(
          transaction,
          `INSERT INTO order_items (
             purchase_order_id, sku, product_name, item_type, supplier_id, quantity,
             unit_price_tax_included_minor, amount_tax_included_minor, due_date,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [orderId, item.sku, item.productName, item.itemType, item.supplierId, item.quantity, item.unitPriceTaxIncludedMinor, item.amountTaxIncludedMinor, item.dueDate] as never[],
        );
        const linked = await transaction.execute(
          `INSERT INTO purchase_plan_order_links (
             purchase_plan_item_id, order_item_id, allocated_quantity, match_method,
             confirmed_by, created_at, updated_at
           ) VALUES (?, ?, ?, 'manual', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [item.planItemId, orderItemId, item.quantity, access.userId] as never[],
        );
        if (linked.affectedRows !== 1) throw new Error("Purchase plan allocation write failed");
        const outside = Number(item.rateBps) > planItem.overToleranceBps;
        if (outside) deviations.push({ planItemId: planItem.id, sku: String(item.sku), type: "over_plan", rateBps: Number(item.rateBps) });
        const completionStatus = outside ? "over_plan_pending" : Number(item.rateBps) >= -planItem.underToleranceBps ? "within_tolerance" : "not_ordered";
        const updated = await transaction.execute(
          `UPDATE purchase_plan_items
           SET ordered_quantity = ?, completion_status = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND ordered_quantity = ? AND completion_status = ?`,
          [item.cumulative, completionStatus, planItem.id, planItem.orderedQuantity, planItem.completionStatus] as never[],
        );
        if (updated.affectedRows !== 1) return conflict("Purchase plan allocation changed concurrently");
        affectedPlanIds.add(planItem.purchasePlanId);
      }
      for (const planId of affectedPlanIds) {
        const rows = await planItems(transaction, planId);
        const complete = rows.every((row) => ["within_tolerance", "exception_approved"].includes(row.completionStatus));
        const lockedPlan = lockedPlans.get(planId);
        if (lockedPlan === undefined) throw new Error("Locked purchase plan unavailable");
        const updated = await transaction.execute(
          `UPDATE purchase_plans SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND status = ? AND updated_at = ?`,
          [complete ? "ordered_complete" : "ordering", planId, lockedPlan.status, lockedPlan.updatedAt],
        );
        if (updated.affectedRows !== 1) return conflict("Purchase plan changed concurrently");
      }
      let approvalId: number | undefined;
      if (deviations.length > 0) approvalId = await createApproval(transaction, { entityId: orderId, entityType: "purchase_order", idempotencyKey, payload: deviations, requestedBy: access.userId, summary: `${orderNo} has purchase-plan quantity deviations`, workflowType: "purchase_plan_deviation" });
      const confirmationDueAt = deviations.length > 0 ? null : new Date(Date.now() + 86_400_000).toISOString();
      if (confirmationDueAt !== null) await createReminder(transaction, { reminderType: "purchase_order_confirmation", entityType: "purchase_order", entityId: orderId, businessNo: orderNo, dueAt: confirmationDueAt });
      const order = { id: orderId, orderNo, sourceFileKey, status: initialStatus, orderDate, totalTaxIncludedMinor: total };
      await audit(transaction, request, access, { action: "create", module: "purchase_orders", entityType: "purchase_order", entityId: orderId, businessNo: orderNo, after: { ...order, items: prepared, deviations } });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: orderId, entityType: "purchase_order", eventType: "PurchaseOrderFactoryConfirmationDue", idempotencyKey, recipient: { kind: "entity_binding", role: "factory", entityType: "purchase_order", entityId: orderId }, data: { orderNo, deviationCount: 0 } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: orderId, targetEntityType: "purchase_order", workflowType: "purchase_plan_deviation" });
      }
      return { order, approvalRequired: deviations.length > 0, deviations, confirmationDueAt };
    },
  });
}

export async function updatePurchaseOrder(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const id = positiveInteger(body.id, "Purchase order required");
  const expectedUpdatedAt = expectedTimestamp(body.expectedUpdatedAt);
  if (!access.roles.includes("factory") || access.factoryId === null) return forbidden("Factory role and binding are required");
  const factoryId = access.factoryId;
  requireFactoryBinding(access, factoryId);
  const decision = text(body.decision, 20);
  if (decision !== "confirmed" && decision !== "unable") return bad("Invalid factory decision");
  const proposedDueDate = decision === "unable" ? date(body.proposedDueDate) : optionalText(body.proposedDueDate, 10);
  const reason = decision === "unable" ? text(body.reason, 2_000) : (optionalText(body.reason, 2_000) ?? "");
  return executeR2Command({
    actorScope: `user:${access.userId}`,
    command: "purchase-orders.update",
    context,
    payload: jsonValue(body),
    request,
    run: async ({ idempotencyKey, transaction }) => {
      const orders = await transaction.query<OrderRow>(
        `SELECT id, order_no AS orderNo, status, updated_at AS updatedAt
         FROM purchase_orders WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id],
      );
      const order = orders[0];
      if (order === undefined) return missing("Purchase order not found");
      if (order.updatedAt !== expectedUpdatedAt) return conflict("Purchase order changed concurrently");
      if (order.status !== "factory_confirmation") return conflict("Purchase order does not require factory confirmation");
      const scopes = await transaction.query<DataRow & { factoryId: number }>(
        `SELECT DISTINCT ppi.factory_id AS factoryId
         FROM order_items oi
         JOIN purchase_plan_order_links ppol ON ppol.order_item_id = oi.id
         JOIN purchase_plan_items ppi ON ppi.id = ppol.purchase_plan_item_id
         WHERE oi.purchase_order_id = ? FOR SHARE`,
        [id],
      );
      if (scopes.length === 0 || scopes.some((scope) => scope.factoryId !== factoryId)) {
        return forbidden("Purchase order is not exclusively bound to this factory");
      }
      const status = decision === "confirmed" ? "confirmed" : "disputed";
      const updated = await transaction.execute(
        `UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'factory_confirmation' AND updated_at = ?`,
        [status, id, expectedUpdatedAt],
      );
      if (updated.affectedRows !== 1) return conflict("Purchase order changed concurrently");
      const approvalId = decision === "unable" ? await createApproval(transaction, { entityId: id, entityType: "purchase_order", idempotencyKey, payload: { proposedDueDate, reason, factoryId }, requestedBy: access.userId, summary: `${order.orderNo} cannot meet the due date`, workflowType: "purchase_order_factory_exception" }) : undefined;
      await audit(transaction, request, access, { action: decision === "confirmed" ? "confirm" : "request_exception", module: "purchase_orders", entityType: "purchase_order", entityId: id, businessNo: order.orderNo, after: { decision, proposedDueDate, reason, factoryId, status } });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: id, entityType: "purchase_order", eventType: "PurchaseOrderConfirmed", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { factoryId } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: id, targetEntityType: "purchase_order", workflowType: "purchase_order_factory_exception" });
      }
      return { success: true, status };
    },
  });
}
