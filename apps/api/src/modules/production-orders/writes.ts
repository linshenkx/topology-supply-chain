import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  integer,
  internal,
  jsonObject,
  lockVersion,
  oneOf,
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";

function deviationBps(actual: number, expected: number): number {
  return expected <= 0 ? (actual === expected ? 0 : 10_000) : Math.round(Math.abs(actual - expected) * 10_000 / expected);
}

async function readReservationPool(
  command: OperationsCommandContext,
  orderId: number,
  componentSku?: string,
): Promise<readonly Row[]> {
  const skuFilter = componentSku === undefined ? "" : " AND ib.sku = ?";
  const params = componentSku === undefined ? [orderId] : [orderId, componentSku];
  return command.transaction.query<Row>(
    `SELECT ir.id, ir.batch_id AS batchId, ir.reserved_quantity AS reservedQuantity,
            ib.warehouse_id AS warehouseId, ib.locked_quantity AS lockedQuantity, ib.sku
     FROM inventory_reservations ir
     JOIN inventory_batches ib ON ib.id = ir.batch_id
     WHERE ir.entity_type = 'production_order' AND ir.entity_id = ? AND ir.status = 'active'${skuFilter}
     ORDER BY ir.priority DESC, ir.id ASC`,
    params,
  );
}

async function lockFreezeForPool(
  command: OperationsCommandContext,
  pool: readonly Row[],
): Promise<void> {
  const byWarehouse = new Map<number, Set<string>>();
  for (const row of pool) {
    const warehouseId = Number(row.warehouseId);
    if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) continue;
    const sku = String(row.sku);
    if (!byWarehouse.has(warehouseId)) byWarehouse.set(warehouseId, new Set());
    byWarehouse.get(warehouseId)!.add(sku);
  }
  const warehouseIds = Array.from(byWarehouse.keys()).sort((a, b) => a - b);
  for (const warehouseId of warehouseIds) {
    const skus = Array.from(byWarehouse.get(warehouseId)!).sort();
    for (const sku of skus) {
      if (await freezeExists(command.transaction, warehouseId, sku)) {
        throw new PlatformError(409, "CONFLICT", "Inventory is frozen by an active stocktake");
      }
    }
  }
}

async function lockActiveReservations(
  command: OperationsCommandContext,
  orderId: number,
  componentSku?: string,
): Promise<readonly Row[]> {
  const pool = await readReservationPool(command, orderId, componentSku);
  await lockFreezeForPool(command, pool);
  const skuFilter = componentSku === undefined ? "" : " AND ib.sku = ?";
  const params = componentSku === undefined ? [orderId] : [orderId, componentSku];
  return command.transaction.query<Row>(
    `SELECT ir.id, ir.batch_id AS batchId, ir.reserved_quantity AS reservedQuantity,
            ib.warehouse_id AS warehouseId, ib.locked_quantity AS lockedQuantity, ib.sku
     FROM inventory_reservations ir
     JOIN inventory_batches ib ON ib.id = ir.batch_id
     WHERE ir.entity_type = 'production_order' AND ir.entity_id = ? AND ir.status = 'active'${skuFilter}
     ORDER BY ir.priority DESC, ir.id ASC
     FOR UPDATE`,
    params,
  );
}

async function consumeReservedInventory(
  command: OperationsCommandContext,
  reservations: readonly Row[],
  quantity: number,
): Promise<void> {
  if (quantity <= 0) return;
  let remaining = quantity;
  for (const reservation of reservations) {
    if (remaining === 0) break;
    const reserved = Number(reservation.reservedQuantity);
    if (reserved <= 0) continue;
    const take = Math.min(remaining, reserved);
    const reservationUpdated = await command.transaction.execute(
      `UPDATE inventory_reservations
       SET reserved_quantity = reserved_quantity - ?,
           status = CASE WHEN reserved_quantity = 0 THEN 'consumed' ELSE 'active' END,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'active' AND reserved_quantity >= ?`,
      [take, reservation.id, take],
    );
    if (reservationUpdated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Reservation changed concurrently");
    const batchUpdated = await command.transaction.execute(
      `UPDATE inventory_batches SET locked_quantity = locked_quantity - ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND locked_quantity >= ?`,
      [take, reservation.batchId, take],
    );
    if (batchUpdated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory changed concurrently");
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
       VALUES (?, ?, 'production_consumption', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [reservation.warehouseId, reservation.sku, -take, `production_consumption:${randomUUID()}`, command.access.userId],
    );
    remaining -= take;
  }
  if (remaining !== 0) throw new PlatformError(409, "CONFLICT", "Insufficient reserved inventory");
}

async function releaseReservedMaterials(
  command: OperationsCommandContext,
  orderId: number,
): Promise<number> {
  const reservations = await lockActiveReservations(command, orderId);
  if (reservations.length === 0) {
    throw new PlatformError(409, "CONFLICT", "No active reservations to release");
  }
  let released = 0;
  for (const reservation of reservations) {
    const remaining = Number(reservation.reservedQuantity);
    if (remaining <= 0) continue;
    const reservationUpdated = await command.transaction.execute(
      `UPDATE inventory_reservations
       SET reserved_quantity = 0, status = 'released', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'active' AND reserved_quantity = ?`,
      [reservation.id, remaining],
    );
    if (reservationUpdated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Reservation changed concurrently");
    const batchUpdated = await command.transaction.execute(
      `UPDATE inventory_batches
       SET locked_quantity = locked_quantity - ?, available_quantity = available_quantity + ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND locked_quantity >= ?`,
      [remaining, remaining, reservation.batchId, remaining],
    );
    if (batchUpdated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory changed concurrently");
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
       VALUES (?, ?, 'production_release', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [reservation.warehouseId, reservation.sku, remaining, `production_release:${randomUUID()}`, command.access.userId],
    );
    released += remaining;
  }
  if (released <= 0) {
    throw new PlatformError(409, "CONFLICT", "No positive reserved quantity to release");
  }
  return released;
}

export async function createProductionOrder(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const orderItemId = integer(body.orderItemId, "orderItemId");
  const requestedFactoryId = integer(body.factoryId, "factoryId");
  const factoryId = requestedFactoryId;
  if (!internal(command.access) && (command.access.factoryId === null || requestedFactoryId !== command.access.factoryId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden factory binding");
  }
  const bomId = integer(body.bomId, "bomId");
  const plannedQuantity = integer(body.plannedQuantity, "plannedQuantity");
  const plannedStartDate = string(body.plannedStartDate, "plannedStartDate", 100);
  const plannedFinishDate = string(body.plannedFinishDate, "plannedFinishDate", 100);
  if (plannedStartDate > plannedFinishDate) throw new PlatformError(400, "BAD_REQUEST", "Invalid production date range");
  const itemRows = await command.transaction.query<Row>(
    `SELECT oi.id, oi.sku, oi.item_type AS itemType, oi.due_date AS dueDate,
            po.order_date AS orderDate
     FROM order_items oi JOIN purchase_orders po ON po.id = oi.purchase_order_id
     WHERE oi.id = ? LIMIT 1 FOR UPDATE`, [orderItemId],
  );
  const item = itemRows[0];
  if (item === undefined || item.itemType !== "finished") {
    throw new PlatformError(400, "BAD_REQUEST", "Production order requires a finished-good order item");
  }
  const allocations = await command.transaction.query<Row>(
    `SELECT l.id, l.allocated_quantity AS allocatedQuantity,
            p.id AS planItemId, p.factory_id AS factoryId, p.sku
     FROM purchase_plan_order_links l
     JOIN purchase_plan_items p ON p.id = l.purchase_plan_item_id
     WHERE l.order_item_id = ? ORDER BY l.id ASC FOR UPDATE`, [orderItemId],
  );
  if (allocations.length === 0 || allocations.some((row) =>
    Number(row.factoryId) !== requestedFactoryId || String(row.sku) !== String(item.sku))) {
    throw new PlatformError(403, "FORBIDDEN", "Production factory is not the authoritative purchase-plan allocation");
  }
  const allocatedQuantity = allocations.reduce((sum, row) => sum + Number(row.allocatedQuantity), 0);
  if (!Number.isSafeInteger(allocatedQuantity) || allocatedQuantity <= 0) {
    throw new PlatformError(409, "CONFLICT", "Purchase-plan allocation is invalid");
  }
  const bomRows = await command.transaction.query<Row>(
    `SELECT id, finished_sku AS finishedSku, version, active, approval_status AS approvalStatus,
            effective_from AS effectiveFrom, effective_to AS effectiveTo
     FROM product_boms WHERE id = ? LIMIT 1 FOR SHARE`, [bomId],
  );
  const bom = bomRows[0];
  if (bom === undefined || bom.finishedSku !== item.sku || Number(bom.active) !== 1 || bom.approvalStatus !== "approved") {
    throw new PlatformError(400, "BAD_REQUEST", "BOM is not an approved active version for this SKU");
  }
  if (typeof item.orderDate !== "string" || item.orderDate < String(bom.effectiveFrom) ||
      (bom.effectiveTo !== null && bom.effectiveTo !== undefined && item.orderDate > String(bom.effectiveTo))) {
    throw new PlatformError(400, "BAD_REQUEST", "BOM was not effective on the purchase-order date");
  }
  const existing = await command.transaction.query<Row>(
    `SELECT id, planned_quantity AS plannedQuantity
     FROM execution_orders WHERE order_item_id = ? ORDER BY id ASC FOR UPDATE`, [orderItemId],
  );
  const cumulativePlanned = existing.reduce((sum, row) => sum + Number(row.plannedQuantity), 0);
  if (cumulativePlanned + plannedQuantity > allocatedQuantity) {
    throw new PlatformError(409, "CONFLICT", "Production plan exceeds authoritative allocated quantity");
  }
  const executionNo = `MO-${randomUUID()}`;
  const inserted = await command.transaction.execute(
    `INSERT INTO execution_orders (
       execution_no, order_item_id, factory_id, bom_id, planned_quantity, completed_quantity,
       status, due_date, planned_start_date, planned_finish_date, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, 'planned', ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [executionNo, orderItemId, factoryId, bomId, plannedQuantity, item.dueDate ?? null, plannedStartDate, plannedFinishDate],
  );
  const id = inserted.insertId!;
  const components = await command.transaction.query<Row>(
    `SELECT id, quantity_per_finished AS quantityPerFinished
     FROM bom_components WHERE bom_id = ? ORDER BY id ASC FOR SHARE`, [bomId],
  );
  for (const component of components) {
    const theoreticalQuantity = Number(component.quantityPerFinished) * plannedQuantity;
    await command.transaction.execute(
      `INSERT INTO production_material_lines (
         execution_order_id, bom_component_id, theoretical_quantity, reserved_quantity,
         issued_quantity, consumed_quantity, loss_quantity, deviation_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 'within_tolerance', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [id, component.id, theoreticalQuantity, theoreticalQuantity],
    );
  }
  await lockVersion(command.transaction, "execution_order", id);
  await audit(command.transaction, command.access, command.request, {
    action: "create", module: "production", entityType: "execution_order", entityId: id,
    businessNo: executionNo, after: { orderItemId, factoryId, bomId, bomVersion: bom.version, plannedQuantity,
      allocatedQuantity, cumulativePlanned: cumulativePlanned + plannedQuantity, plannedStartDate, plannedFinishDate },
  });
  await domainEvent(context, command.transaction, {
    type: "ProductionOrderCreated", aggregateType: "execution_order", aggregateId: id,
    payload: { bomId, bomVersion: String(bom.version), materialLineCount: components.length },
  });
  return { order: { id, executionNo, orderItemId, factoryId, bomId, plannedQuantity, status: "planned", version: 1 } };
}

async function updateMaterials(command: OperationsCommandContext, orderId: number, raw: unknown): Promise<boolean> {
  if (!Array.isArray(raw)) return false;
  let deviation = false;
  for (const value of raw) {
    const input = jsonObject(value);
    const id = integer(input.id, "material.id");
    const issued = integer(input.issuedQuantity, "issuedQuantity", 0);
    const consumed = integer(input.consumedQuantity, "consumedQuantity", 0);
    const loss = integer(input.lossQuantity, "lossQuantity", 0);
    if (consumed + loss > issued) throw new PlatformError(409, "CONFLICT", "Material consumption and loss exceed issued quantity");
    const rows = await command.transaction.query<Row>(
      `SELECT p.id, p.theoretical_quantity AS theoreticalQuantity, p.reserved_quantity AS reservedQuantity,
              p.issued_quantity AS currentIssuedQuantity,
              p.consumed_quantity AS currentConsumedQuantity,
              p.loss_quantity AS currentLossQuantity,
              b.component_sku AS componentSku,
              b.issue_tolerance_bps AS issueToleranceBps,
              b.consumption_tolerance_bps AS consumptionToleranceBps,
              b.loss_tolerance_bps AS lossToleranceBps
       FROM production_material_lines p JOIN bom_components b ON b.id = p.bom_component_id
       WHERE p.id = ? AND p.execution_order_id = ? LIMIT 1 FOR UPDATE`, [id, orderId],
    );
    const line = rows[0];
    if (line === undefined) throw new PlatformError(404, "NOT_FOUND", "Production material line not found");
    const currentIssued = Number(line.currentIssuedQuantity);
    const currentConsumed = Number(line.currentConsumedQuantity);
    const currentLoss = Number(line.currentLossQuantity);
    const deltaIssued = issued - currentIssued;
    const deltaConsumed = consumed - currentConsumed;
    const deltaLoss = loss - currentLoss;
    if (deltaIssued < 0 || deltaConsumed < 0 || deltaLoss < 0) {
      throw new PlatformError(409, "CONFLICT", "Material quantities cannot be decreased");
    }
    const reservations = await lockActiveReservations(command, orderId, String(line.componentSku));
    const activeReserved = reservations.reduce((sum, reservation) => sum + Number(reservation.reservedQuantity), 0);
    if (issued > currentConsumed + currentLoss + activeReserved) {
      throw new PlatformError(409, "CONFLICT", "Issued quantity exceeds real inventory reservations");
    }
    const theoretical = Number(line.theoreticalQuantity);
    const exceeds = deviationBps(issued, theoretical) > Number(line.issueToleranceBps) ||
      deviationBps(consumed, theoretical) > Number(line.consumptionToleranceBps) ||
      deviationBps(loss, theoretical) > Number(line.lossToleranceBps);
    deviation ||= exceeds;
    const updated = await command.transaction.execute(
      `UPDATE production_material_lines
       SET issued_quantity = ?, consumed_quantity = ?, loss_quantity = ?, deviation_status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND execution_order_id = ?`,
      [issued, consumed, loss, exceeds ? "pending_approval" : "within_tolerance", id, orderId],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Material line changed concurrently");
    await consumeReservedInventory(command, reservations, deltaConsumed + deltaLoss);
  }
  return deviation;
}

export async function transitionProductionOrder(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const id = integer(body.id, "id");
  const action = oneOf(body.action, ["start", "materials", "complete", "release_materials"] as const, "action");
  const rows = await command.transaction.query<Row>(
    `SELECT eo.*, oi.sku FROM execution_orders eo JOIN order_items oi ON oi.id = eo.order_item_id
     WHERE eo.id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const order = rows[0];
  if (order === undefined) throw new PlatformError(404, "NOT_FOUND", "Production order not found");
  if (!internal(command.access) && (command.access.factoryId === null || Number(order.factory_id) !== command.access.factoryId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden factory binding");
  }
  const version = await lockVersion(command.transaction, "execution_order", id);
  if (action === "release_materials") {
    if (!["planned", "in_production"].includes(String(order.status))) {
      throw new PlatformError(409, "CONFLICT", "Production order cannot release materials from its current state");
    }
    const releasedQuantity = await releaseReservedMaterials(command, id);
    const nextVersion = await bumpVersion(command.transaction, "execution_order", id, version);
    await audit(command.transaction, command.access, command.request, {
      action, module: "production", entityType: "execution_order", entityId: id,
      businessNo: String(order.execution_no), after: { releasedQuantity, version: nextVersion },
    });
    await domainEvent(context, command.transaction, {
      type: "ProductionReservationReleased", aggregateType: "execution_order", aggregateId: id,
      deduplicationSuffix: nextVersion,
    });
    return { success: true, id, releasedQuantity, version: nextVersion };
  }
  if (action === "start") {
    const updated = await command.transaction.execute(
      `UPDATE execution_orders SET status = 'in_production', actual_start_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'planned'`, [id],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Production order cannot be started");
    const nextVersion = await bumpVersion(command.transaction, "execution_order", id, version);
    await audit(command.transaction, command.access, command.request, {
      action, module: "production", entityType: "execution_order", entityId: id,
      businessNo: String(order.execution_no), before: { status: order.status }, after: { status: "in_production", version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "ProductionOrderStarted", aggregateType: "execution_order", aggregateId: id });
    return { success: true, id, status: "in_production", version: nextVersion };
  }
  const materialDeviation = await updateMaterials(command, id, body.materials);
  if (action === "materials") {
    const nextVersion = await bumpVersion(command.transaction, "execution_order", id, version);
    await audit(command.transaction, command.access, command.request, {
      action, module: "production", entityType: "execution_order", entityId: id,
      businessNo: String(order.execution_no), after: { materialDeviation, version: nextVersion },
    });
    await domainEvent(context, command.transaction, {
      type: "ProductionMaterialsReported", aggregateType: "execution_order", aggregateId: id,
      deduplicationSuffix: nextVersion,
    });
    return { success: true, id, status: order.status, materialDeviation, version: nextVersion };
  }
  if (!["planned", "in_production"].includes(String(order.status))) {
    throw new PlatformError(409, "CONFLICT", "Production order cannot be completed from its current state");
  }
  const actual = integer(body.actualFinishedQuantity, "actualFinishedQuantity", 0);
  const planned = Number(order.planned_quantity);
  const skuRows = await command.transaction.query<Row>(
    `SELECT overproduction_tolerance_bps AS tolerance FROM skus WHERE code = ? LIMIT 1 FOR SHARE`, [order.sku],
  );
  const variance = actual - planned;
  const rate = deviationBps(actual, planned);
  const over = variance > 0 && rate > Number(skuRows[0]?.tolerance ?? 0);
  const under = variance < 0;
  const pending = over || under || materialDeviation;
  const report = await command.transaction.execute(
    `INSERT INTO production_reports (
       execution_order_id, actual_finished_quantity, variance_quantity, variance_rate_bps,
       result, company_inventory_quantity, factory_owned_quantity, reported_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [id, actual, variance, rate, over ? "overproduction_quarantined" : under ? "underproduction_pending" : "within_tolerance",
     pending ? 0 : actual, command.access.userId],
  );
  const reportId = report.insertId!;
  const claimed = await command.transaction.execute(
    `UPDATE execution_orders
     SET status = ?, completed_quantity = ?, actual_finish_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status IN ('planned','in_production')`,
    [pending ? "variance_pending" : "completed", actual, id],
  );
  if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Production order changed concurrently");
  let approvalId: number | undefined;
  if (pending) {
    const approval = await command.transaction.execute(
      `INSERT INTO approval_requests (
         request_no, workflow_type, entity_type, entity_id, summary, payload_json,
         high_risk, status, requested_by, requested_at, created_at, updated_at
       ) VALUES (?, 'production_variance', 'production_report', ?, ?, ?, 0, 'pending', ?,
                 CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [`APR-PROD-${randomUUID()}`, reportId, `Production variance ${order.execution_no}`,
       JSON.stringify({ executionOrderId: id, overproduction: over, underproduction: under, materialDeviation }), command.access.userId],
    );
    approvalId = approval.insertId!;
  } else if (actual > 0) {
    const warehouses = await command.transaction.query<Row>(
      `SELECT id FROM warehouses WHERE factory_id = ? AND status = 'active'
       ORDER BY CASE WHEN type = 'factory' THEN 0 ELSE 1 END, id ASC LIMIT 1 FOR SHARE`, [order.factory_id],
    );
    const warehouseId = Number(warehouses[0]?.id);
    if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) {
      throw new PlatformError(409, "CONFLICT", "Factory has no active production warehouse");
    }
    await lockWarehouseFreeze(command.transaction, warehouseId);
    if (await freezeExists(command.transaction, warehouseId, String(order.sku))) {
      throw new PlatformError(409, "CONFLICT", "Production warehouse is frozen by a stocktake");
    }
    const batchNo = `PROD-${order.execution_no}-${reportId}-C`;
    const completedBatch = await command.transaction.execute(
      `INSERT INTO inventory_batches (
         batch_no, warehouse_id, sku, production_date, inbound_date,
         pending_inspection_quantity, ownership, expiry_status, created_at, updated_at
       ) VALUES (?, ?, ?, CURRENT_DATE(), CURRENT_DATE(), ?, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [batchNo, warehouseId, order.sku, actual],
    );
    await command.transaction.execute(
      `UPDATE production_reports SET batch_id = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [completedBatch.insertId!, reportId],
    );
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
       VALUES (?, ?, 'inbound_pending_inspection', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [warehouseId, order.sku, actual, `production_report:${reportId}:company`, command.access.userId],
    );
    await command.transaction.execute(
      `UPDATE production_material_lines SET reserved_quantity = 0, updated_at = CURRENT_TIMESTAMP(3)
       WHERE execution_order_id = ?`, [id],
    );
  }
  const nextVersion = await bumpVersion(command.transaction, "execution_order", id, version);
  await audit(command.transaction, command.access, command.request, {
    action, module: "production", entityType: "execution_order", entityId: id,
    businessNo: String(order.execution_no), before: { status: order.status },
    after: { status: pending ? "variance_pending" : "completed", actualFinishedQuantity: actual, reportId, approvalId, version: nextVersion },
  });
  await domainEvent(context, command.transaction, {
    type: pending ? "ProductionVarianceRequested" : "ProductionOrderCompleted",
    aggregateType: "execution_order", aggregateId: id,
    payload: { reportId, ...(approvalId === undefined ? {} : { approvalId }) },
  });
  return { success: true, id, reportId, status: pending ? "variance_pending" : "completed", approvalId, version: nextVersion };
}
