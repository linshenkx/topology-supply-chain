import type { FastifyRequest } from "fastify";

import { consumeStepUpClaim } from "../../platform/approvals.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import type { AccessContext } from "../auth/index.js";
import { executeSupplyCommand } from "../../platform/supply-command.js";
import { approvalNotification, createApproval } from "../approvals/support.js";
import { requireFile } from "../files/support.js";
import {
  audit,
  bad,
  canonicalHash,
  conflict,
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
  previousDay,
  requireFactoryBinding,
  text,
  type DataRow,
} from "../../platform/supply-support.js";
const REVIEW_TYPES = new Set(["satisfaction", "sampling"]);

interface SupplierRow extends DataRow {
  code: string;
  id: number;
  managedByFactoryId: number | null;
  name: string;
  tier: number | null;
}

interface SkuRow extends DataRow {
  code: string;
  id: number;
  itemType: string | null;
  stockUnit: string | null;
}
export async function writeSupplier(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const code = text(body.code, 191);
  const name = text(body.name, 500);
  const tier = positiveInteger(body.tier);
  if (![1, 2, 3].includes(tier)) return bad("Supplier tier must be 1, 2, or 3");
  const managedByFactoryId = tier === 1 ? null : positiveInteger(body.managedByFactoryId, "Managed factory required");
  const directFactory = tier === 3 && managedByFactoryId !== null && access.roles.includes("factory") && access.factoryId === managedByFactoryId;
  if (!directFactory && !isInternal(access)) return forbidden();
  if (access.roles.includes("factory") && !isInternal(access) && managedByFactoryId !== null) requireFactoryBinding(access, managedByFactoryId);
  const licenseKey = text(body.businessLicenseFileKey, 1_000);
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "suppliers.write",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: 201,
    run: async ({ idempotencyKey, transaction }) => {
      const license = await requireFile(transaction, access, /^\d+$/u.test(licenseKey) ? { id: Number(licenseKey) } : { objectKey: licenseKey }, ["business_license", "supplier_evidence"]);
      if (managedByFactoryId !== null) {
        const factories = await transaction.query<DataRow>("SELECT id FROM factories WHERE id = ? AND status = 'active' LIMIT 1 FOR SHARE", [managedByFactoryId]);
        if (factories[0] === undefined) return missing("Managed factory not found");
      }
      const existing = await transaction.query<DataRow>("SELECT id FROM suppliers WHERE code = ? LIMIT 1 FOR UPDATE", [code]);
      if (existing[0] !== undefined) return conflict("Supplier code already exists");
      const supplierId = await insertId(
        transaction,
        `INSERT INTO suppliers (
           code, name, tier, managed_by_factory_id, unified_social_credit_code,
           business_license_file_key, address, contact_name, contact_phone, business_scope,
           source, verification_status, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [code, name, tier, managedByFactoryId, text(body.unifiedSocialCreditCode, 200), license.objectKey, text(body.address, 1_000), text(body.contactName, 200), text(body.contactPhone, 100), text(body.businessScope, 2_000), directFactory ? "approved" : "pending", directFactory ? "active" : "draft"],
      );
      const approvalId = directFactory ? undefined : await createApproval(transaction, { entityId: supplierId, entityType: "supplier", idempotencyKey, payload: body, requestedBy: access.userId, summary: `New tier ${tier} supplier: ${name}`, workflowType: "supplier_onboarding" });
      const supplier = { id: supplierId, code, name, tier, managedByFactoryId, verificationStatus: directFactory ? "approved" : "pending", status: directFactory ? "active" : "draft" };
      await audit(transaction, request, access, { action: "create", module: "suppliers", entityType: "supplier", entityId: supplierId, businessNo: code, after: supplier });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: supplierId, entityType: "supplier", eventType: "SupplierActivated", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { tier } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: supplierId, targetEntityType: "supplier", workflowType: "supplier_onboarding" });
      }
      return { supplier, approvalRequired: !directFactory };
    },
  });
}

interface SupplierSkuRow extends DataRow {
  dailyCapacity: number | null;
  effectiveFrom: string;
  factoryId: number;
  id: number;
  isPrimary: number | boolean;
  leadTimeDays: number | null;
  minimumOrderQuantity: number;
  monthlyCapacity: number | null;
  packagingMultiple: number;
  priority: number;
  purchaseUnit: string;
  requestedBy: number;
  sku: string;
  status: string;
  supplierId: number;
  updatedAt: string;
}

export function supplierSkuTargetHash(row: Omit<SupplierSkuRow, "id" | "updatedAt">): string {
  return canonicalHash({
    dailyCapacity: row.dailyCapacity,
    effectiveFrom: row.effectiveFrom,
    factoryId: row.factoryId,
    isPrimary: row.isPrimary === true || row.isPrimary === 1,
    leadTimeDays: row.leadTimeDays,
    minimumOrderQuantity: row.minimumOrderQuantity,
    monthlyCapacity: row.monthlyCapacity,
    packagingMultiple: row.packagingMultiple,
    priority: row.priority,
    purchaseUnit: row.purchaseUnit,
    requestedBy: row.requestedBy,
    sku: row.sku,
    status: row.status,
    supplierId: row.supplierId,
  });
}

export async function writeSupplierSku(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const factoryId = positiveInteger(body.factoryId);
  const supplierId = positiveInteger(body.supplierId);
  const sku = text(body.sku, 191);
  const effectiveFrom = date(body.effectiveFrom);
  if (!isInternal(access)) requireFactoryBinding(access, factoryId);
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "supplier-skus.write",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: (result) => result.created === true ? 201 : 200,
    run: async ({ idempotencyKey, transaction }) => {
      const factories = await transaction.query<DataRow & { code: string; name: string }>("SELECT id, code, name FROM factories WHERE id = ? AND status = 'active' LIMIT 1 FOR SHARE", [factoryId]);
      const suppliers = await transaction.query<SupplierRow>("SELECT id, code, name, tier, managed_by_factory_id AS managedByFactoryId FROM suppliers WHERE id = ? LIMIT 1 FOR SHARE", [supplierId]);
      const skus = await transaction.query<SkuRow>("SELECT id, code, item_type AS itemType, stock_unit AS stockUnit FROM skus WHERE code = ? AND status = 'active' LIMIT 1 FOR SHARE", [sku]);
      const factory = factories[0]; const supplier = suppliers[0]; const skuRow = skus[0];
      if (factory === undefined || supplier === undefined || skuRow === undefined) return missing("Factory, supplier, or active SKU not found");
      if ((supplier.tier ?? 1) > 1 && supplier.managedByFactoryId !== factoryId) return conflict("Supplier is not managed by this factory");
      const directFactory = access.roles.includes("factory") && !isInternal(access) && supplier.tier === 3 && access.factoryId === factoryId;
      const existingRows = await transaction.query<SupplierSkuRow>(
        `SELECT id, factory_id AS factoryId, supplier_id AS supplierId, sku,
                is_primary AS isPrimary, priority,
                minimum_order_quantity AS minimumOrderQuantity,
                packaging_multiple AS packagingMultiple, purchase_unit AS purchaseUnit,
                lead_time_days AS leadTimeDays, daily_capacity AS dailyCapacity,
                monthly_capacity AS monthlyCapacity, effective_from AS effectiveFrom,
                status, requested_by AS requestedBy, updated_at AS updatedAt
         FROM supplier_skus
         WHERE factory_id = ? AND supplier_id = ? AND sku = ? LIMIT 1 FOR UPDATE`,
        [factoryId, supplierId, sku],
      );
      const existing = existingRows[0];
      const values = {
        isPrimary: body.isPrimary === true,
        priority: positiveInteger(body.priority ?? 1),
        minimumOrderQuantity: positiveInteger(body.minimumOrderQuantity ?? 1),
        packagingMultiple: positiveInteger(body.packagingMultiple ?? 1),
        purchaseUnit: optionalText(body.purchaseUnit, 100) ?? skuRow.stockUnit ?? "",
        leadTimeDays: body.leadTimeDays == null ? null : nonNegativeInteger(body.leadTimeDays),
        dailyCapacity: body.dailyCapacity == null ? null : positiveInteger(body.dailyCapacity),
        monthlyCapacity: body.monthlyCapacity == null ? null : positiveInteger(body.monthlyCapacity),
      };
      let relationId: number;
      if (existing === undefined) {
        relationId = await insertId(
          transaction,
          `INSERT INTO supplier_skus (
             factory_id, supplier_id, sku, is_primary, priority, minimum_order_quantity,
             packaging_multiple, purchase_unit, lead_time_days, daily_capacity, monthly_capacity,
             effective_from, status, requested_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [factoryId, supplierId, sku, values.isPrimary ? 1 : 0, values.priority, values.minimumOrderQuantity, values.packagingMultiple, values.purchaseUnit, values.leadTimeDays, values.dailyCapacity, values.monthlyCapacity, effectiveFrom, directFactory ? "active" : "pending", access.userId],
        );
      } else {
        relationId = existing.id;
        const updated = await transaction.execute(
          `UPDATE supplier_skus SET
             is_primary = ?, priority = ?, minimum_order_quantity = ?, packaging_multiple = ?,
             purchase_unit = ?, lead_time_days = ?, daily_capacity = ?, monthly_capacity = ?,
             effective_from = ?, status = ?, requested_by = ?, reviewed_by = NULL,
             reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND updated_at = ?`,
          [values.isPrimary ? 1 : 0, values.priority, values.minimumOrderQuantity, values.packagingMultiple, values.purchaseUnit, values.leadTimeDays, values.dailyCapacity, values.monthlyCapacity, effectiveFrom, directFactory ? "active" : "pending", access.userId, relationId, existing.updatedAt],
        );
        if (updated.affectedRows !== 1) return conflict("Supplier-SKU relation changed concurrently");
      }
      const relation = { id: relationId, factoryId, supplierId, sku, effectiveFrom, status: directFactory ? "active" : "pending", ...values };
      await transaction.execute(
        `INSERT IGNORE INTO resource_versions (resource_type, resource_id, version, updated_at)
         VALUES ('supplier_sku', ?, 1, CURRENT_TIMESTAMP(3))`,
        [String(relationId)],
      );
      const versionRows = await transaction.query<DataRow & { version: number }>(
        `SELECT version FROM resource_versions
         WHERE resource_type = 'supplier_sku' AND resource_id = ? LIMIT 1 FOR UPDATE`,
        [String(relationId)],
      );
      const currentVersion = versionRows[0]?.version;
      if (currentVersion === undefined) throw new Error("Supplier-SKU version unavailable");
      const targetVersion = existing === undefined ? currentVersion : currentVersion + 1;
      if (existing !== undefined) {
        const bumped = await transaction.execute(
          `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
           WHERE resource_type = 'supplier_sku' AND resource_id = ? AND version = ?`,
          [String(relationId), currentVersion],
        );
        if (bumped.affectedRows !== 1) return conflict("Supplier-SKU version changed concurrently");
      }
      const targetHash = supplierSkuTargetHash({
        dailyCapacity: values.dailyCapacity,
        effectiveFrom,
        factoryId,
        isPrimary: values.isPrimary,
        leadTimeDays: values.leadTimeDays,
        minimumOrderQuantity: values.minimumOrderQuantity,
        monthlyCapacity: values.monthlyCapacity,
        packagingMultiple: values.packagingMultiple,
        priority: values.priority,
        purchaseUnit: values.purchaseUnit,
        requestedBy: access.userId,
        sku,
        status: relation.status,
        supplierId,
      });
      let approvalId: number | undefined;
      if (!directFactory) approvalId = await createApproval(transaction, { entityId: relationId, entityType: "supplier_sku", idempotencyKey, payload: { factoryId, supplierId, sku, effectiveFrom, ...values, targetVersion, targetHash }, requestedBy: access.userId, summary: `${existing === undefined ? "New" : "Updated"} supplier-SKU relation`, workflowType: "supplier_sku_change" });
      await audit(transaction, request, access, { action: existing === undefined ? "create" : "update", module: "suppliers", entityType: "supplier_sku", entityId: relationId, businessNo: `${factory.code}-${sku}`, before: existing, after: relation });
      if (approvalId === undefined) {
        await domainEvent(context, transaction, { entityId: relationId, entityType: "supplier_sku", eventType: "SupplierSkuActivated", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { factoryId, supplierId, sku } });
      } else {
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: relationId, targetEntityType: "supplier_sku", workflowType: "supplier_sku_change" });
      }
      return { relation, approvalRequired: !directFactory, created: existing === undefined };
    },
  });
}

interface AgreementRow extends DataRow {
  effectiveFrom: string;
  id: number;
}

export async function writeSupplierPrice(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const supplierId = positiveInteger(body.supplierId);
  const sku = text(body.sku, 191);
  const included = positiveInteger(body.taxIncludedMinor);
  const excluded = positiveInteger(body.taxExcludedMinor);
  const taxRate = nonNegativeInteger(body.taxRateBps);
  if (taxRate > 10_000) return bad("Tax rate is out of range");
  const effectiveFrom = date(body.effectiveFrom);
  const reason = text(body.reason, 2_000);
  const evidenceFileKey = text(body.evidenceFileKey, 1_000);
  const digestPayload = { ...body };
  delete digestPayload.challengeNo;
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "supplier-prices.write",
    context,
    payload: jsonValue(digestPayload),
    request,
    responseStatus: 201,
    run: async ({ idempotencyKey, requestDigest, transaction }) => {
      const suppliers = await transaction.query<SupplierRow>("SELECT id, code, name, tier, managed_by_factory_id AS managedByFactoryId FROM suppliers WHERE id = ? LIMIT 1 FOR SHARE", [supplierId]);
      const supplier = suppliers[0];
      const skuRows = await transaction.query<SkuRow>("SELECT id, code, item_type AS itemType, stock_unit AS stockUnit FROM skus WHERE code = ? AND status = 'active' LIMIT 1 FOR SHARE", [sku]);
      if (supplier === undefined || skuRows[0] === undefined) return missing("Supplier or active SKU not found");
      const directFactory = supplier.tier === 3 && access.roles.includes("factory") && access.factoryId !== null && supplier.managedByFactoryId === access.factoryId;
      if (supplier.tier === 3 && isInternal(access)) return forbidden("Tier-3 prices are maintained by the bound factory");
      if (!directFactory && !isInternal(access)) return forbidden();
      if (directFactory && supplier.managedByFactoryId !== null) requireFactoryBinding(access, supplier.managedByFactoryId);
      const relations = await transaction.query<DataRow & { id: number }>(
        `SELECT id FROM supplier_skus
         WHERE supplier_id = ? AND sku = ? AND status = 'active'
           AND (? IS NULL OR factory_id = ?) ORDER BY id FOR SHARE`,
        [supplierId, sku, directFactory ? access.factoryId : null, directFactory ? access.factoryId : null],
      );
      if (relations[0] === undefined) return conflict("An active supplier-SKU relation is required");
      const evidence = await requireFile(
        transaction,
        access,
        /^\d+$/u.test(evidenceFileKey) ? { id: Number(evidenceFileKey) } : { objectKey: evidenceFileKey },
        ["price_evidence"],
        { entityType: "supplier_sku", entityIds: relations.map((relation) => relation.id) },
      );
      const currentRows = await transaction.query<AgreementRow>(
        `SELECT id, effective_from AS effectiveFrom FROM core_price_agreements
         WHERE supplier_id = ? AND sku = ? AND status = 'active'
         ORDER BY effective_from DESC, id DESC LIMIT 1 FOR UPDATE`,
        [supplierId, sku],
      );
      const current = currentRows[0];
      if (current !== undefined && effectiveFrom <= current.effectiveFrom) return conflict("New price must start after the active price");
      const resourceId = `${supplierId}:${sku}`;
      await transaction.execute(
        `INSERT IGNORE INTO resource_versions (resource_type, resource_id, version, updated_at)
         VALUES ('supplier_price', ?, 1, CURRENT_TIMESTAMP(3))`,
        [resourceId],
      );
      const versions = await transaction.query<DataRow & { version: number }>(
        `SELECT version FROM resource_versions
         WHERE resource_type = 'supplier_price' AND resource_id = ? LIMIT 1 FOR UPDATE`,
        [resourceId],
      );
      const version = versions[0]?.version;
      if (version === undefined) throw new Error("Price version unavailable");
      if (directFactory) {
        if (access.sessionId === null) return forbidden("Authenticated session required");
        const objectVersion = positiveInteger(body.objectVersion, "Price object version required");
        if (objectVersion !== version) return conflict("Price version changed; repeat step-up");
        await consumeStepUpClaim(transaction, {
          action: "supplier_price.activate",
          challengeNo: text(body.challengeNo, 191),
          objectId: resourceId,
          objectType: "r2:supplier_price",
          objectVersion,
          requestDigest,
          sessionId: access.sessionId,
          userId: access.userId,
        });
        if (current !== undefined) {
          const retired = await transaction.execute(
            `UPDATE core_price_agreements SET effective_to = ?, status = 'inactive', updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND status = 'active'`,
            [previousDay(effectiveFrom), current.id],
          );
          if (retired.affectedRows !== 1) return conflict("Active price changed concurrently");
        }
        const agreementId = await insertId(
          transaction,
          `INSERT INTO core_price_agreements (
             supplier_id, sku, currency, unit_price_tax_included_minor,
             unit_price_tax_excluded_minor, tax_rate_bps, effective_from, status,
             maintained_by, created_at, updated_at
           ) VALUES (?, ?, 'CNY', ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [supplierId, sku, included, excluded, taxRate, effectiveFrom, access.userId],
        );
        const bumped = await transaction.execute(
          `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
           WHERE resource_type = 'supplier_price' AND resource_id = ? AND version = ?`,
          [resourceId, version],
        );
        if (bumped.affectedRows !== 1) return conflict("Price version changed concurrently");
        const agreement = { id: agreementId, supplierId, sku, currency: "CNY", unitPriceTaxIncludedMinor: included, unitPriceTaxExcludedMinor: excluded, taxRateBps: taxRate, effectiveFrom, status: "active", objectVersion: version + 1 };
        await audit(transaction, request, access, { action: "create", module: "supplier_prices", entityType: "price_agreement", entityId: agreementId, businessNo: `${supplier.code}-${sku}`, after: agreement });
        await domainEvent(context, transaction, { entityId: agreementId, entityType: "price_agreement", eventType: "SupplierPriceActivated", idempotencyKey, recipient: { kind: "entity_binding", role: "factory", entityType: "supplier_sku", entityId: relations[0]!.id }, data: { supplierId, sku } });
        return { agreement, approvalRequired: false };
      }
      const changeId = await insertId(
        transaction,
        `INSERT INTO core_price_change_requests (
           current_agreement_id, supplier_id, sku, proposed_tax_included_minor,
           proposed_tax_excluded_minor, proposed_tax_rate_bps, proposed_effective_from,
           reason, evidence_file_key, requested_by, decision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [current?.id ?? null, supplierId, sku, included, excluded, taxRate, effectiveFrom, reason, evidence.objectKey, access.userId],
      );
      const approvalId = await createApproval(transaction, { entityId: changeId, entityType: "supplier_price_change", highRisk: true, idempotencyKey, payload: { currentAgreementId: current?.id ?? null, supplierId, sku, proposedTaxIncludedMinor: included, proposedTaxExcludedMinor: excluded, proposedTaxRateBps: taxRate, proposedEffectiveFrom: effectiveFrom, reason, evidenceFileKey, requestedBy: access.userId, priceResourceId: resourceId, priceVersion: version }, requestedBy: access.userId, summary: `${current === undefined ? "New" : "Updated"} supplier price: ${supplier.name} / ${sku}`, workflowType: "supplier_price_change" });
      const change = { id: changeId, currentAgreementId: current?.id ?? null, supplierId, sku, proposedTaxIncludedMinor: included, proposedTaxExcludedMinor: excluded, proposedTaxRateBps: taxRate, proposedEffectiveFrom: effectiveFrom, reason, evidenceFileKey: evidence.objectKey, decision: "pending" };
      await audit(transaction, request, access, { action: "create", module: "supplier_prices", entityType: "price_change_request", entityId: changeId, businessNo: `${supplier.code}-${sku}`, after: change });
      await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: changeId, targetEntityType: "supplier_price_change", workflowType: "supplier_price_change" });
      return { request: change, approvalRequired: true };
    },
  });
}

interface PerformanceRow extends DataRow {
  id: number;
  updatedAt: string;
}

export async function writeSupplierPerformance(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  const action = text(body.action, 30);
  if (action === "review") {
    if (!access.roles.some((role) => ["admin", "supply_chain", "company_qc"].includes(role))) return forbidden();
  } else if (action === "weights") {
    if (!isInternal(access)) return forbidden();
  } else return bad("Unsupported supplier performance action");
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "supplier-performance.write",
    context,
    payload: jsonValue(body),
    request,
    run: async ({ idempotencyKey, transaction }) => {
      if (action === "review") {
        const supplierId = positiveInteger(body.supplierId);
        const quarter = text(body.quarter, 7);
        if (!/^\d{4}-Q[1-4]$/u.test(quarter)) return bad("Invalid quarter");
        const reviewType = text(body.reviewType, 30);
        if (!REVIEW_TYPES.has(reviewType)) return bad("Invalid review type");
        const score = positiveInteger(body.score);
        if (score > 5) return bad("Review score must be between 1 and 5");
        const supplierRows = await transaction.query<SupplierRow>("SELECT id, code, name, tier, managed_by_factory_id AS managedByFactoryId FROM suppliers WHERE id = ? LIMIT 1 FOR SHARE", [supplierId]);
        const supplier = supplierRows[0];
        if (supplier === undefined) return missing("Supplier not found");
        if (reviewType === "satisfaction" && supplier.tier !== 1) return bad("Satisfaction review applies only to tier-1 suppliers");
        const existingRows = await transaction.query<PerformanceRow>(
          `SELECT id, updated_at AS updatedAt FROM supplier_performance_reviews
           WHERE supplier_id = ? AND quarter = ? AND review_type = ? AND evaluator_user_id = ?
           LIMIT 1 FOR UPDATE`,
          [supplierId, quarter, reviewType, access.userId],
        );
        const existing = existingRows[0];
        const tags = Array.isArray(body.tags) ? body.tags.slice(0, 20).map((value) => text(value, 100)) : [];
        const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2_000) : "";
        let reviewId: number;
        if (existing === undefined) {
          reviewId = await insertId(
            transaction,
            `INSERT INTO supplier_performance_reviews (
               supplier_id, quarter, review_type, score, tags_json, comment,
               evaluator_user_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [supplierId, quarter, reviewType, score, JSON.stringify(tags), comment, access.userId],
          );
        } else {
          reviewId = existing.id;
          const updated = await transaction.execute(
            `UPDATE supplier_performance_reviews SET score = ?, tags_json = ?, comment = ?, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND updated_at = ?`,
            [score, JSON.stringify(tags), comment, reviewId, existing.updatedAt],
          );
          if (updated.affectedRows !== 1) return conflict("Supplier review changed concurrently");
        }
        await audit(transaction, request, access, { action: existing === undefined ? "create_review" : "update_review", module: "supplier_performance", entityType: "supplier_review", entityId: reviewId, businessNo: supplier.code, before: existing, after: { supplierId, quarter, reviewType, score, tags, comment, reviewerIdentityHiddenExternally: true } });
        await domainEvent(context, transaction, { entityId: reviewId, entityType: "supplier_review", eventType: "SupplierReviewRecorded", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { supplierId, quarter, reviewType } });
        return { ok: true, reviewId };
      }
      const tier = positiveInteger(body.tier);
      if (![1, 2, 3].includes(tier)) return bad("Invalid supplier tier");
      const effectiveFrom = date(body.effectiveFrom);
      const keys = ["delivery", "quality", "exception", "preparation", "satisfaction", "sampling"] as const;
      const weights = Object.fromEntries(keys.map((key) => [key, Math.round(Number(body[key]) * 100)])) as Record<(typeof keys)[number], number>;
      if (keys.some((key) => !Number.isFinite(weights[key]) || weights[key] < 0) || Object.values(weights).reduce((sum, value) => sum + value, 0) !== 10_000 || (tier !== 1 && weights.satisfaction !== 0)) return bad("Weights must be non-negative and total 100%; satisfaction is zero for tiers 2 and 3");
      const existingRows = await transaction.query<PerformanceRow>(
        `SELECT id, updated_at AS updatedAt FROM supplier_performance_weight_versions
         WHERE tier = ? AND effective_from = ? LIMIT 1 FOR UPDATE`,
        [tier, effectiveFrom],
      );
      const existing = existingRows[0];
      let weightId: number;
      if (existing === undefined) {
        weightId = await insertId(
          transaction,
          `INSERT INTO supplier_performance_weight_versions (
             tier, effective_from, delivery_weight_bps, quality_weight_bps,
             exception_weight_bps, preparation_weight_bps, satisfaction_weight_bps,
             sampling_weight_bps, status, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [tier, effectiveFrom, weights.delivery, weights.quality, weights.exception, weights.preparation, weights.satisfaction, weights.sampling, access.userId],
        );
      } else {
        weightId = existing.id;
        const updated = await transaction.execute(
          `UPDATE supplier_performance_weight_versions SET
             delivery_weight_bps = ?, quality_weight_bps = ?, exception_weight_bps = ?,
             preparation_weight_bps = ?, satisfaction_weight_bps = ?, sampling_weight_bps = ?,
             status = 'active', updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND updated_at = ?`,
          [weights.delivery, weights.quality, weights.exception, weights.preparation, weights.satisfaction, weights.sampling, weightId, existing.updatedAt],
        );
        if (updated.affectedRows !== 1) return conflict("Weight version changed concurrently");
      }
      await audit(transaction, request, access, { action: existing === undefined ? "create_weights" : "update_weights", module: "supplier_performance", entityType: "performance_weights", entityId: weightId, before: existing, after: { tier, effectiveFrom, ...weights } });
      await domainEvent(context, transaction, { entityId: weightId, entityType: "performance_weights", eventType: "SupplierPerformanceWeightsChanged", idempotencyKey, recipient: { kind: "role", role: "supply_chain" }, data: { tier, effectiveFrom } });
      return { ok: true, weightId };
    },
  });
}
