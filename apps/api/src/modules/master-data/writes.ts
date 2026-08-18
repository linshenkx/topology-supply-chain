import type { FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import type { AccessContext } from "../auth/index.js";
import { executeSupplyCommand } from "../../platform/supply-command.js";
import { approvalNotification, createApproval } from "../approvals/support.js";
import {
  audit,
  bad,
  conflict,
  date,
  forbidden,
  insertId,
  isInternal,
  jsonValue,
  objectBody,
  optionalText,
  positiveInteger,
  previousDay,
  text,
  type DataRow,
} from "../../platform/supply-support.js";
const ITEM_TYPES = new Set(["finished", "auxiliary", "component"]);

function bps(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > 100) return bad("Tolerance must be between 0 and 100 percent");
  return Math.round(number * 100);
}
interface SkuInput {
  effectiveFrom: string | null;
  itemType: string;
  name: string;
  overproductionToleranceBps: number;
  purchaseOverToleranceBps: number;
  purchaseQuantity: number;
  purchaseUnderToleranceBps: number;
  purchaseUnit: string | null;
  stockQuantity: number;
  stockUnit: string;
}
interface SkuRow extends DataRow {
  code: string;
  id: number;
  itemType: string | null;
  stockUnit: string | null;
  status: string;
  verificationStatus: string;
}
interface ConversionRow extends DataRow {
  id: number;
}
interface BomRow extends DataRow {
  active: number | boolean;
  approvalStatus: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  id: number;
  version: string;
}

function skuInput(body: Record<string, unknown>): SkuInput {
  const name = text(body.name, 500);
  const itemType = text(body.itemType, 30);
  const stockUnit = text(body.stockUnit, 100);
  if (!ITEM_TYPES.has(itemType)) return bad("Invalid SKU item type");
  const purchaseUnit = optionalText(body.purchaseUnit, 100);
  return {
    effectiveFrom: purchaseUnit === null ? null : date(body.effectiveFrom),
    itemType,
    name,
    overproductionToleranceBps: bps(body.overproductionTolerance),
    purchaseOverToleranceBps: bps(body.purchaseOverTolerance),
    purchaseQuantity:
      purchaseUnit === null ? 0 : positiveInteger(body.purchaseUnitQuantity),
    purchaseUnderToleranceBps: bps(body.purchaseUnderTolerance),
    purchaseUnit,
    stockQuantity:
      purchaseUnit === null ? 0 : positiveInteger(body.stockUnitQuantity),
    stockUnit,
  };
}

async function upsertResubmittedConversion(
  transaction: QueryExecutor,
  skuId: number,
  input: SkuInput,
): Promise<void> {
  if (input.purchaseUnit === null || input.effectiveFrom === null) return;
  const conversions = await transaction.query<ConversionRow>(
    `SELECT id FROM sku_unit_conversions
     WHERE sku_id = ?
     ORDER BY status = 'active' DESC, effective_from DESC, id DESC
     LIMIT 1 FOR UPDATE`,
    [skuId],
  );
  const existing = conversions[0];
  if (existing === undefined) {
    const result = await transaction.execute(
      `INSERT INTO sku_unit_conversions (
         sku_id, purchase_unit, stock_unit, purchase_unit_quantity, stock_unit_quantity,
         effective_from, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [
        skuId,
        input.purchaseUnit,
        input.stockUnit,
        input.purchaseQuantity,
        input.stockQuantity,
        input.effectiveFrom,
      ],
    );
    if (result.affectedRows !== 1) throw new Error("SKU conversion write failed");
    return;
  }
  const changed = await transaction.execute(
    `UPDATE sku_unit_conversions
     SET purchase_unit = ?, stock_unit = ?, purchase_unit_quantity = ?,
         stock_unit_quantity = ?, effective_from = ?, status = 'active',
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND sku_id = ?`,
    [
      input.purchaseUnit,
      input.stockUnit,
      input.purchaseQuantity,
      input.stockQuantity,
      input.effectiveFrom,
      existing.id,
      skuId,
    ],
  );
  if (changed.affectedRows !== 1) return conflict("SKU conversion changed concurrently");
}

export async function writeMasterData(
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  raw: unknown,
) {
  const body = objectBody(raw);
  if (!isInternal(access)) return forbidden();
  const action = text(body.action, 50);
  if (action !== "create_sku" && action !== "resubmit_sku" && action !== "create_bom") return bad("Unsupported master-data action");
  return executeSupplyCommand({
    actorScope: `user:${access.userId}`,
    command: "master-data.write",
    context,
    payload: jsonValue(body),
    request,
    responseStatus: 201,
    run: async ({ idempotencyKey, transaction }) => {
      if (action === "create_sku") {
        const code = text(body.code, 191).toUpperCase();
        const input = skuInput(body);
        const existing = await transaction.query<DataRow>("SELECT id FROM skus WHERE code = ? LIMIT 1 FOR UPDATE", [code]);
        if (existing[0] !== undefined) return conflict("SKU code already exists");
        const skuId = await insertId(
          transaction,
          `INSERT INTO skus (
             code, name, item_type, stock_unit, serial_tracking_enabled,
             overproduction_tolerance_bps, purchase_over_tolerance_bps,
             purchase_under_tolerance_bps, verification_status, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'pending', 'draft', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [
            code,
            input.name,
            input.itemType,
            input.stockUnit,
            input.overproductionToleranceBps,
            input.purchaseOverToleranceBps,
            input.purchaseUnderToleranceBps,
          ],
        );
        if (input.purchaseUnit !== null && input.effectiveFrom !== null) {
          const conversion = await transaction.execute(
            `INSERT INTO sku_unit_conversions (
               sku_id, purchase_unit, stock_unit, purchase_unit_quantity, stock_unit_quantity,
               effective_from, status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [
              skuId,
              input.purchaseUnit,
              input.stockUnit,
              input.purchaseQuantity,
              input.stockQuantity,
              input.effectiveFrom,
            ],
          );
          if (conversion.affectedRows !== 1) throw new Error("SKU conversion write failed");
        }
        const approvalId = await createApproval(transaction, { entityId: skuId, entityType: "sku", idempotencyKey, payload: body, requestedBy: access.userId, summary: `New SKU: ${code} ${input.name}`, workflowType: "sku_verification" });
        const sku = { id: skuId, code, name: input.name, itemType: input.itemType, stockUnit: input.stockUnit, verificationStatus: "pending", status: "draft" };
        await audit(transaction, request, access, { action: "create", module: "master_data", entityType: "sku", entityId: skuId, businessNo: code, after: sku });
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: skuId, targetEntityType: "sku", workflowType: "sku_verification" });
        return { sku, approvalRequired: true };
      }

      if (action === "resubmit_sku") {
        const skuId = positiveInteger(body.id, "SKU id required");
        const input = skuInput(body);
        const rows = await transaction.query<SkuRow>(
          `SELECT id, code, item_type AS itemType, stock_unit AS stockUnit,
                  status, verification_status AS verificationStatus
           FROM skus WHERE id = ? LIMIT 1 FOR UPDATE`,
          [skuId],
        );
        const current = rows[0];
        if (current === undefined) return conflict("SKU cannot be resubmitted");
        if (current.verificationStatus !== "rejected" || current.status !== "draft") {
          return conflict("Only rejected draft SKU can be resubmitted");
        }
        const changed = await transaction.execute(
          `UPDATE skus
           SET name = ?, item_type = ?, stock_unit = ?,
               overproduction_tolerance_bps = ?, purchase_over_tolerance_bps = ?,
               purchase_under_tolerance_bps = ?, verification_status = 'pending',
               status = 'draft', updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND verification_status = 'rejected' AND status = 'draft'`,
          [
            input.name,
            input.itemType,
            input.stockUnit,
            input.overproductionToleranceBps,
            input.purchaseOverToleranceBps,
            input.purchaseUnderToleranceBps,
            skuId,
          ],
        );
        if (changed.affectedRows !== 1) return conflict("SKU changed concurrently");
        await upsertResubmittedConversion(transaction, skuId, input);
        const approvalId = await createApproval(transaction, { entityId: skuId, entityType: "sku", idempotencyKey, payload: body, requestedBy: access.userId, summary: `Resubmitted SKU: ${current.code} ${input.name}`, workflowType: "sku_verification" });
        const sku = { id: skuId, code: current.code, name: input.name, itemType: input.itemType, stockUnit: input.stockUnit, verificationStatus: "pending", status: "draft" };
        await audit(transaction, request, access, { action: "resubmit", module: "master_data", entityType: "sku", entityId: skuId, businessNo: current.code, before: current, after: { sku, approvalId } });
        await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: skuId, targetEntityType: "sku", workflowType: "sku_verification" });
        return { sku, approvalRequired: true, resubmitted: true };
      }

      const finishedSku = text(body.finishedSku, 191).toUpperCase();
      const version = text(body.version, 191);
      const effectiveFrom = date(body.effectiveFrom);
      const effectiveTo = body.effectiveTo == null || body.effectiveTo === "" ? null : date(body.effectiveTo);
      if (effectiveTo !== null && effectiveTo < effectiveFrom) return bad("BOM end date cannot precede start date");
      const overlapAllowed = body.overlapAllowed === true;
      const overlapReason = overlapAllowed ? text(body.overlapReason, 1_000) : "";
      if (overlapAllowed && effectiveTo === null) return bad("Overlapping BOM requires an end date");
      if (!Array.isArray(body.components) || body.components.length === 0 || body.components.length > 500) return bad("BOM components required");
      const finishedRows = await transaction.query<SkuRow>("SELECT id, code, item_type AS itemType, stock_unit AS stockUnit FROM skus WHERE code = ? LIMIT 1 FOR SHARE", [finishedSku]);
      if (finishedRows[0]?.itemType !== "finished") return bad("Finished SKU not found");
      const existing = await transaction.query<BomRow>(
        `SELECT id, version, effective_from AS effectiveFrom, effective_to AS effectiveTo,
                approval_status AS approvalStatus, active
         FROM product_boms WHERE finished_sku = ? ORDER BY effective_from, id FOR UPDATE`,
        [finishedSku],
      );
      if (existing.some((row) => row.version === version)) return conflict("BOM version already exists");
      const conflicting = existing.filter((row) => (row.active === true || row.active === 1) && ["pending", "approved"].includes(row.approvalStatus) && effectiveFrom <= (row.effectiveTo ?? "9999-12-31") && row.effectiveFrom <= (effectiveTo ?? "9999-12-31"));
      if (!overlapAllowed && conflicting.some((row) => row.effectiveFrom >= effectiveFrom)) return conflict("New BOM effective date conflicts with an existing version");
      const retireBomIds = overlapAllowed ? [] : conflicting.filter((row) => row.approvalStatus === "approved").map((row) => row.id);
      const seen = new Set<string>();
      const components: Array<Record<string, unknown>> = [];
      for (const candidate of body.components.map(objectBody)) {
        const componentSku = text(candidate.componentSku, 191).toUpperCase();
        if (seen.has(componentSku)) return bad("BOM component SKU cannot repeat");
        seen.add(componentSku);
        const skuRows = await transaction.query<SkuRow>("SELECT id, code, item_type AS itemType, stock_unit AS stockUnit FROM skus WHERE code = ? LIMIT 1 FOR SHARE", [componentSku]);
        const component = skuRows[0];
        if (component === undefined || !["auxiliary", "component"].includes(component.itemType ?? "")) return bad(`Invalid BOM component: ${componentSku}`);
        components.push({
          componentSku,
          itemType: component.itemType,
          isCore: candidate.isCore === true,
          quantityPerFinished: positiveInteger(candidate.quantityPerFinished),
          issueToleranceBps: bps(candidate.issueTolerance),
          consumptionToleranceBps: bps(candidate.consumptionTolerance),
          lossToleranceBps: bps(candidate.lossTolerance),
        });
      }
      const bomId = await insertId(
        transaction,
        `INSERT INTO product_boms (
           finished_sku, version, effective_from, effective_to, overlap_allowed, overlap_reason,
           approval_status, active, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [finishedSku, version, effectiveFrom, effectiveTo, overlapAllowed ? 1 : 0, overlapReason, access.userId],
      );
      for (const component of components) {
        const result = await transaction.execute(
          `INSERT INTO bom_components (
             bom_id, component_sku, item_type, is_core, quantity_per_finished,
             issue_tolerance_bps, consumption_tolerance_bps, loss_tolerance_bps
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [bomId, component.componentSku, component.itemType, component.isCore ? 1 : 0, component.quantityPerFinished, component.issueToleranceBps, component.consumptionToleranceBps, component.lossToleranceBps] as never[],
        );
        if (result.affectedRows !== 1) throw new Error("BOM component write failed");
      }
      const approvalPayload = { ...body, retireBomIds, retirementDate: previousDay(effectiveFrom) };
      const approvalId = await createApproval(transaction, { entityId: bomId, entityType: "bom", idempotencyKey, payload: approvalPayload, requestedBy: access.userId, summary: `BOM version: ${finishedSku} / ${version}`, workflowType: "bom_version" });
      const bom = { id: bomId, finishedSku, version, effectiveFrom, effectiveTo, overlapAllowed, overlapReason, approvalStatus: "pending", active: true };
      await audit(transaction, request, access, { action: "create", module: "master_data", entityType: "bom", entityId: bomId, businessNo: `${finishedSku}-${version}`, after: { bom, components, retireBomIds } });
      await approvalNotification(context, transaction, { approvalId, idempotencyKey, targetEntityId: bomId, targetEntityType: "bom", workflowType: "bom_version" });
      return { bom, approvalRequired: true, retireBomIds };
    },
  });
}
