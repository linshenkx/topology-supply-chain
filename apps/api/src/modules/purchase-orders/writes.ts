import type { FastifyRequest } from "fastify";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import type { AccessContext } from "../auth/index.js";
import { executeSupplyCommand } from "../../platform/supply-command.js";
import { approvalNotification, createApproval } from "../approvals/support.js";
import { requireFile } from "../files/support.js";
import { createReminder } from "../notifications/support.js";
import { type OrderRow } from "./support.js";
import { planItems, type PlanItemRow, type PlanRow } from "../purchase-plans/support.js";
import { type PriceRow, type SupplierRow } from "../suppliers/support.js";
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
  nonNegativeInteger,
  objectBody,
  optionalText,
  positiveInteger,
  requireFactoryBinding,
  text,
  type DataRow,
} from "../../platform/supply-support.js";
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
  return executeSupplyCommand({
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
  return executeSupplyCommand({
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
