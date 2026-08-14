import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { lockWarehouseFreeze } from "./support.js";
import { requireWarehouseScope } from "../warehouses/support.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  integer,
  internal,
  jsonObject,
  lockVersion,
  oneOf,
  optionalInteger,
  optionalString,
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";


export async function openStocktake(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain"]);
  const body = jsonObject(raw);
  const warehouseId = integer(body.warehouseId, "warehouseId");
  const scope = oneOf(body.scope, ["full_warehouse", "sku_sample", "batch"] as const, "scope");
  const dueDate = string(body.dueDate, "dueDate", 100);
  const assignedFactoryId = optionalInteger(body.assignedFactoryId, "assignedFactoryId");
  const warehouse = await requireWarehouseScope(command.transaction, command.access, warehouseId);
  await lockWarehouseFreeze(command.transaction, warehouseId);
  const active = await command.transaction.query<Row>(
    `SELECT id FROM stocktakes WHERE warehouse_id = ? AND status IN ('first_count','recount','pending_approval')
     LIMIT 1 FOR UPDATE`, [warehouseId],
  );
  if (active.length > 0) throw new PlatformError(409, "CONFLICT", "Warehouse already has an active stocktake");
  let filter = "";
  let params: unknown[] = [warehouseId];
  if (scope === "sku_sample") {
    const skus = Array.isArray(body.skus) ? body.skus.map((value) => string(value, "sku", 191)) : [];
    if (skus.length === 0) throw new PlatformError(400, "BAD_REQUEST", "SKU sample is empty");
    filter = ` AND sku IN (${skus.map(() => "?").join(",")})`;
    params = [...params, ...skus];
  } else if (scope === "batch") {
    const batchIds = Array.isArray(body.batchIds) ? body.batchIds.map((value) => integer(value, "batchId")) : [];
    if (batchIds.length === 0) throw new PlatformError(400, "BAD_REQUEST", "Batch sample is empty");
    filter = ` AND id IN (${batchIds.map(() => "?").join(",")})`;
    params = [...params, ...batchIds];
  }
  const batches = await command.transaction.query<Row>(
    `SELECT id, sku, available_quantity AS availableQuantity, locked_quantity AS lockedQuantity,
            defective_quantity AS defectiveQuantity, pending_inspection_quantity AS pendingInspectionQuantity
     FROM inventory_batches WHERE warehouse_id = ?${filter} ORDER BY id ASC FOR SHARE`, params as never,
  );
  if (batches.length === 0) throw new PlatformError(409, "CONFLICT", "Stocktake has no inventory targets");
  const stocktakeNo = `ST-${randomUUID()}`;
  const inserted = await command.transaction.execute(
    `INSERT INTO stocktakes (
       stocktake_no, warehouse_id, scope, due_date, status, frozen_at, created_by,
       assigned_factory_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'first_count', CURRENT_TIMESTAMP(3), ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [stocktakeNo, warehouseId, scope, dueDate, command.access.userId, assignedFactoryId],
  );
  const stocktakeId = inserted.insertId!;
  for (const batch of batches) {
    const total = Number(batch.availableQuantity) + Number(batch.lockedQuantity) + Number(batch.defectiveQuantity) + Number(batch.pendingInspectionQuantity);
    await command.transaction.execute(
      `INSERT INTO stocktake_counts (
         stocktake_id, batch_id, sku, count_round, available_quantity, locked_quantity,
         defective_quantity, pending_inspection_quantity, total_quantity, counted_by, counted_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
      [stocktakeId, batch.id, batch.sku, batch.availableQuantity, batch.lockedQuantity, batch.defectiveQuantity, batch.pendingInspectionQuantity, total, command.access.userId],
    );
  }
  await lockVersion(command.transaction, "stocktake", stocktakeId);
  await audit(command.transaction, command.access, command.request, {
    action: "open", module: "stocktake", entityType: "stocktake", entityId: stocktakeId,
    businessNo: stocktakeNo, after: { warehouseId, scope, dueDate, assignedFactoryId, targetCount: batches.length },
  });
  await domainEvent(context, command.transaction, {
    type: "StocktakeOpened", aggregateType: "stocktake", aggregateId: stocktakeId,
    payload: { warehouseCode: String(warehouse.code), dueDate, targetCount: batches.length },
  });
  return { stocktake: { id: stocktakeId, stocktakeNo, warehouseId, scope, dueDate, status: "first_count", version: 1 } };
}

export async function transitionStocktake(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const id = integer(body.id, "id");
  const action = oneOf(body.action, ["submit_count", "finish_round"] as const, "action");
  const rows = await command.transaction.query<Row>(
    `SELECT id, stocktake_no AS stocktakeNo, warehouse_id AS warehouseId, status,
            assigned_factory_id AS assignedFactoryId, created_by AS createdBy
     FROM stocktakes WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const task = rows[0];
  if (task === undefined) throw new PlatformError(404, "NOT_FOUND", "Stocktake not found");
  await lockWarehouseFreeze(command.transaction, Number(task.warehouseId));
  await requireWarehouseScope(command.transaction, command.access, Number(task.warehouseId));
  if (!internal(command.access) && task.assignedFactoryId !== command.access.factoryId) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden stocktake binding");
  }
  const version = await lockVersion(command.transaction, "stocktake", id);
  if (action === "submit_count") {
    if (!["first_count", "recount"].includes(String(task.status))) throw new PlatformError(409, "CONFLICT", "Stocktake is not countable");
    const round = task.status === "recount" ? 2 : 1;
    const batchId = optionalInteger(body.batchId, "batchId");
    const sku = string(body.sku, "sku", 191);
    const available = integer(body.availableQuantity, "availableQuantity", 0);
    const locked = integer(body.lockedQuantity, "lockedQuantity", 0);
    const defective = integer(body.defectiveQuantity, "defectiveQuantity", 0);
    const pending = integer(body.pendingInspectionQuantity, "pendingInspectionQuantity", 0);
    const snapshot = await command.transaction.query<Row>(
      `SELECT id FROM stocktake_counts
       WHERE stocktake_id = ? AND count_round = 0 AND sku = ?
         AND ((batch_id IS NULL AND ? IS NULL) OR batch_id = ?) LIMIT 1 FOR SHARE`,
      [id, sku, batchId, batchId],
    );
    if (snapshot.length === 0) throw new PlatformError(403, "FORBIDDEN", "Count target is outside stocktake scope");
    const existingCount = await command.transaction.query<Row>(
      `SELECT id FROM stocktake_counts
       WHERE stocktake_id = ? AND count_round = ? AND sku = ?
         AND ((batch_id IS NULL AND ? IS NULL) OR batch_id = ?) LIMIT 1 FOR UPDATE`,
      [id, round, sku, batchId, batchId],
    );
    if (existingCount[0] !== undefined) {
      const rejected = await command.transaction.query<Row>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM stocktake_adjustments WHERE stocktake_count_id = ? FOR UPDATE`, [existingCount[0].id],
      );
      if (round !== 2 || Number(rejected[0]?.total ?? 0) === 0 ||
          Number(rejected[0]?.total) !== Number(rejected[0]?.rejected)) {
        throw new PlatformError(409, "CONFLICT", "This stocktake round was already submitted");
      }
      const revised = await command.transaction.execute(
        `UPDATE stocktake_counts SET available_quantity = ?, locked_quantity = ?,
                defective_quantity = ?, pending_inspection_quantity = ?, total_quantity = ?,
                counted_by = ?, counted_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [available, locked, defective, pending, available + locked + defective + pending,
         command.access.userId, existingCount[0].id],
      );
      if (revised.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Stocktake count changed concurrently");
    } else try {
      await command.transaction.execute(
        `INSERT INTO stocktake_counts (
           stocktake_id, batch_id, sku, count_round, available_quantity, locked_quantity,
           defective_quantity, pending_inspection_quantity, total_quantity, counted_by, counted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
        [id, batchId, sku, round, available, locked, defective, pending, available + locked + defective + pending, command.access.userId],
      );
    } catch {
      throw new PlatformError(409, "CONFLICT", "This stocktake round was already submitted");
    }
    const nextVersion = await bumpVersion(command.transaction, "stocktake", id, version);
    await audit(command.transaction, command.access, command.request, {
      action: "submit_count", module: "stocktake", entityType: "stocktake", entityId: id,
      after: { round, batchId, sku, available, locked, defective, pending, version: nextVersion },
    });
    await domainEvent(context, command.transaction, {
      type: "CountSubmitted", aggregateType: "stocktake", aggregateId: id,
      deduplicationSuffix: `${round}:${batchId ?? sku}`, payload: { round, batchId, sku },
    });
    return { success: true, status: task.status, version: nextVersion };
  }
  requireRole(command.access, ["admin", "supply_chain"]);
  if (!["first_count", "recount"].includes(String(task.status))) throw new PlatformError(409, "CONFLICT", "Stocktake cannot be finished");
  const round = task.status === "recount" ? 2 : 1;
  const counts = await command.transaction.query<Row>(
    `SELECT snap.id AS snapshotId, snap.batch_id AS batchId, snap.sku,
            snap.available_quantity AS snapshotAvailable, snap.locked_quantity AS snapshotLocked,
            snap.defective_quantity AS snapshotDefective,
            snap.pending_inspection_quantity AS snapshotPendingInspection,
            counted.id AS countId, counted.available_quantity AS countedAvailable,
            counted.locked_quantity AS countedLocked, counted.defective_quantity AS countedDefective,
            counted.pending_inspection_quantity AS countedPendingInspection,
            counted.counted_by AS countedBy, round1.counted_by AS round1CountedBy
     FROM stocktake_counts snap
     LEFT JOIN stocktake_counts counted ON counted.stocktake_id = snap.stocktake_id
       AND counted.count_round = ? AND counted.sku = snap.sku
       AND ((counted.batch_id IS NULL AND snap.batch_id IS NULL) OR counted.batch_id = snap.batch_id)
     LEFT JOIN stocktake_counts round1 ON round1.stocktake_id = snap.stocktake_id
       AND round1.count_round = 1 AND round1.sku = snap.sku
       AND ((round1.batch_id IS NULL AND snap.batch_id IS NULL) OR round1.batch_id = snap.batch_id)
     WHERE snap.stocktake_id = ? AND snap.count_round = 0
     ORDER BY snap.id ASC FOR UPDATE`,
    [round, id],
  );
  if (counts.some((row) => row.countId === null || row.countId === undefined)) {
    throw new PlatformError(409, "CONFLICT", "All stocktake targets must be counted");
  }
  if (round === 2 && counts.some((row) => Number(row.countedBy) === Number(row.round1CountedBy))) {
    throw new PlatformError(409, "CONFLICT", "Recount requires separation of duties");
  }
  const buckets = [
    ["available", "snapshotAvailable", "countedAvailable"],
    ["locked", "snapshotLocked", "countedLocked"],
    ["defective", "snapshotDefective", "countedDefective"],
    ["pending_inspection", "snapshotPendingInspection", "countedPendingInspection"],
  ] as const;
  const variances: Array<Row & { bucket: typeof buckets[number][0]; snapshotQuantity: number; countedQuantity: number }> = [];
  for (const row of counts) {
    for (const [bucket, snapshotKey, countedKey] of buckets) {
      const snapshotQuantity = Number(row[snapshotKey]);
      const countedQuantity = Number(row[countedKey]);
      if (snapshotQuantity !== countedQuantity) variances.push({ ...row, bucket, snapshotQuantity, countedQuantity });
    }
  }
  if (round === 1 && variances.length > 0) {
    await command.transaction.execute(
      `UPDATE stocktakes SET status = 'recount', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'first_count'`, [id],
    );
    const nextVersion = await bumpVersion(command.transaction, "stocktake", id, version);
    await audit(command.transaction, command.access, command.request, {
      action: "finish_round", module: "stocktake", entityType: "stocktake", entityId: id,
      after: { status: "recount", varianceLines: variances.length, version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "StocktakeRecountRequired", aggregateType: "stocktake", aggregateId: id });
    return { success: true, status: "recount", version: nextVersion };
  }
  if (variances.length === 0) {
    await command.transaction.execute(
      `UPDATE stocktakes SET status = 'completed', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = ?`, [id, task.status],
    );
    const nextVersion = await bumpVersion(command.transaction, "stocktake", id, version);
    await audit(command.transaction, command.access, command.request, {
      action: "complete", module: "stocktake", entityType: "stocktake", entityId: id,
      after: { status: "completed", varianceLines: 0, version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "StocktakeCompleted", aggregateType: "stocktake", aggregateId: id });
    return { success: true, status: "completed", version: nextVersion };
  }
  for (const variance of variances) {
    const prior = await command.transaction.query<Row>(
      `SELECT id, revision, decision FROM stocktake_adjustments
       WHERE stocktake_id = ? AND stocktake_count_id = ? AND bucket = ?
       LIMIT 1 FOR UPDATE`, [id, variance.countId, variance.bucket],
    );
    if (prior[0] !== undefined) {
      if (prior[0].decision !== "rejected") {
        throw new PlatformError(409, "CONFLICT", "Stocktake adjustment is already active");
      }
      const revised = await command.transaction.execute(
        `UPDATE stocktake_adjustments
         SET variance_quantity = ?, snapshot_quantity = ?, counted_quantity = ?,
             revision = revision + 1, decision = 'pending', reviewed_by = NULL,
             reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND decision = 'rejected'`,
        [variance.countedQuantity - variance.snapshotQuantity, variance.snapshotQuantity,
         variance.countedQuantity, prior[0].id],
      );
      if (revised.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Rejected adjustment changed concurrently");
      continue;
    }
    await command.transaction.execute(
      `INSERT INTO stocktake_adjustments (
         stocktake_id, stocktake_count_id, bucket, snapshot_quantity, counted_quantity,
         variance_quantity, revision, generated_batch_no,
         estimated_production_date, estimated_expiry_date, decision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [id, variance.countId, variance.bucket, variance.snapshotQuantity, variance.countedQuantity,
       variance.countedQuantity - variance.snapshotQuantity,
       variance.batchId === null ? `STG-${task.stocktakeNo}-${variance.countId}` : null,
       variance.batchId === null ? optionalString(body.estimatedProductionDate, 100) || null : null,
       variance.batchId === null ? optionalString(body.estimatedExpiryDate, 100) || null : null],
    );
  }
  const approvalNo = `APR-${task.stocktakeNo}-${randomUUID()}`;
  const approval = await command.transaction.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'stocktake_variance', 'stocktake', ?, ?, ?, 0, 'pending', ?,
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [approvalNo, id, `Stocktake variance ${task.stocktakeNo}`, JSON.stringify({ stocktakeId: id }), command.access.userId],
  );
  await command.transaction.execute(
    `UPDATE stocktakes SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'recount'`, [id],
  );
  const nextVersion = await bumpVersion(command.transaction, "stocktake", id, version);
  await audit(command.transaction, command.access, command.request, {
    action: "submit_approval", module: "stocktake", entityType: "stocktake", entityId: id,
    after: { status: "pending_approval", varianceLines: variances.length, approvalId: approval.insertId, version: nextVersion },
  });
  await domainEvent(context, command.transaction, {
    type: "VarianceApprovalRequested", aggregateType: "stocktake", aggregateId: id,
    recipient: { kind: "role", role: "supply_chain" },
    payload: { approvalId: approval.insertId!, varianceLines: variances.length },
  });
  return { success: true, status: "pending_approval", approvalId: approval.insertId, version: nextVersion };
}
