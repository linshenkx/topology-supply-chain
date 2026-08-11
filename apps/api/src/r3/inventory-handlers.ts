import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../platform/registrations.js";
import { PlatformError } from "../errors.js";
import type { R3CommandContext } from "./command.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  freezeExists,
  integer,
  internal,
  jsonObject,
  lockVersion,
  lockWarehouseFreeze,
  oneOf,
  optionalInteger,
  optionalString,
  requireRole,
  requireWarehouseScope,
  string,
  type Row,
} from "./support.js";

async function requireReservationEntityScope(
  command: R3CommandContext,
  entityType: "historical" | "production_order" | "purchase_order" | "shipment_plan",
  entityId: number | null,
): Promise<void> {
  if (entityType === "historical") {
    if (!internal(command.access)) throw new PlatformError(403, "FORBIDDEN", "Historical reservations require an internal role");
    return;
  }
  if (entityId === null) throw new PlatformError(400, "BAD_REQUEST", "Business entity is required");
  const internalRole = internal(command.access) ? 1 : 0;
  const factoryId = command.access.factoryId;
  const query = entityType === "production_order"
    ? `SELECT 1 AS allowed FROM execution_orders eo
       WHERE eo.id = ? AND (? = 1 OR eo.factory_id = ?) LIMIT 1 FOR SHARE`
    : entityType === "shipment_plan"
      ? `SELECT 1 AS allowed FROM delivery_batches db
         JOIN execution_orders eo ON eo.id = db.execution_order_id
         WHERE db.id = ? AND (? = 1 OR eo.factory_id = ?) LIMIT 1 FOR SHARE`
      : `SELECT 1 AS allowed FROM purchase_orders po
         LEFT JOIN order_items oi ON oi.purchase_order_id = po.id
         LEFT JOIN execution_orders eo ON eo.order_item_id = oi.id
         WHERE po.id = ? AND (? = 1 OR eo.factory_id = ?) LIMIT 1 FOR SHARE`;
  const rows = await command.transaction.query<Row>(query, [entityId, internalRole, factoryId]);
  if (rows[0] === undefined) throw new PlatformError(403, "FORBIDDEN", "Forbidden reservation entity binding");
}

export async function reserveInventory(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const batchId = integer(body.batchId, "batchId");
  const entityType = oneOf(body.entityType, ["purchase_order", "production_order", "shipment_plan", "historical"] as const, "entityType");
  const entityId = optionalInteger(body.entityId, "entityId");
  const requestedQuantity = integer(body.requestedQuantity, "requestedQuantity");
  const priority = body.priority === undefined ? 0 : integer(body.priority, "priority", -1_000);
  if (entityType !== "historical" && entityId === null) {
    throw new PlatformError(400, "BAD_REQUEST", "Business entity is required");
  }
  const batches = await command.transaction.query<Row>(
    `SELECT id, batch_no AS batchNo, warehouse_id AS warehouseId, sku,
            available_quantity AS availableQuantity, quarantine_quantity AS quarantineQuantity,
            expiry_status AS expiryStatus
     FROM inventory_batches WHERE id = ? LIMIT 1`,
    [batchId],
  );
  let batch = batches[0];
  if (batch === undefined) throw new PlatformError(404, "NOT_FOUND", "Inventory batch not found");
  await lockWarehouseFreeze(command.transaction, Number(batch.warehouseId));
  const lockedBatches = await command.transaction.query<Row>(
    `SELECT id, batch_no AS batchNo, warehouse_id AS warehouseId, sku,
            available_quantity AS availableQuantity, quarantine_quantity AS quarantineQuantity,
            expiry_status AS expiryStatus
     FROM inventory_batches WHERE id = ? LIMIT 1 FOR UPDATE`, [batchId],
  );
  batch = lockedBatches[0];
  if (batch === undefined) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory batch changed concurrently");
  await requireWarehouseScope(command.transaction, command.access, Number(batch.warehouseId));
  await requireReservationEntityScope(command, entityType, entityId);
  if (await freezeExists(command.transaction, Number(batch.warehouseId), String(batch.sku))) {
    throw new PlatformError(409, "CONFLICT", "Inventory is frozen by an active stocktake");
  }
  if (batch.expiryStatus === "expired_frozen" || Number(batch.quarantineQuantity) > 0) {
    throw new PlatformError(409, "CONFLICT", "Frozen or quarantined inventory cannot be reserved");
  }
  const available = Math.max(0, Number(batch.availableQuantity));
  const reservedQuantity = Math.min(requestedQuantity, available);
  const shortageQuantity = requestedQuantity - reservedQuantity;
  if (reservedQuantity > 0) {
    const updated = await command.transaction.execute(
      `UPDATE inventory_batches
       SET available_quantity = available_quantity - ?, locked_quantity = locked_quantity + ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND available_quantity >= ?`,
      [reservedQuantity, reservedQuantity, batchId, reservedQuantity],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory changed concurrently");
  }
  const inserted = await command.transaction.execute(
    `INSERT INTO inventory_reservations (
       batch_id, entity_type, entity_id, requested_quantity, reserved_quantity,
       shortage_quantity, priority, status, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [batchId, entityType, entityId, requestedQuantity, reservedQuantity, shortageQuantity, priority, command.access.userId],
  );
  const reservationId = inserted.insertId!;
  await audit(command.transaction, command.access, command.request, {
    action: "reserve", module: "inventory", entityType: "inventory_reservation", entityId: reservationId,
    after: { batchId, entityType, entityId, requestedQuantity, reservedQuantity, shortageQuantity },
  });
  await domainEvent(context, command.transaction, {
    type: shortageQuantity > 0 ? "InventoryShortageDetected" : "InventoryReserved",
    aggregateType: "inventory_reservation", aggregateId: reservationId,
    payload: { batchId, requestedQuantity, reservedQuantity, shortageQuantity },
  });
  return { reservation: { id: reservationId, batchId, requestedQuantity, reservedQuantity, shortageQuantity } };
}

export async function requestTransfer(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const fromWarehouseId = integer(body.fromWarehouseId, "fromWarehouseId");
  const toWarehouseId = integer(body.toWarehouseId, "toWarehouseId");
  const sku = string(body.sku, "sku", 191);
  const quantity = integer(body.quantity, "quantity");
  const reason = string(body.reason, "reason");
  if (fromWarehouseId === toWarehouseId) throw new PlatformError(400, "BAD_REQUEST", "Warehouses must differ");
  const source = await requireWarehouseScope(command.transaction, command.access, fromWarehouseId);
  const targets = await command.transaction.query<Row>(
    `SELECT id, status FROM warehouses WHERE id = ? LIMIT 1 FOR SHARE`, [toWarehouseId],
  );
  if (targets[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Target warehouse not found");
  if (source.status !== "active" || targets[0].status !== "active") {
    throw new PlatformError(409, "CONFLICT", "Inactive warehouses cannot be transferred");
  }
  const transferNo = `TR-${randomUUID()}`;
  const inserted = await command.transaction.execute(
    `INSERT INTO inventory_transfers (
       transfer_no, from_warehouse_id, to_warehouse_id, sku, quantity, reason,
       status, requested_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending_supply_chain', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [transferNo, fromWarehouseId, toWarehouseId, sku, quantity, reason, command.access.userId],
  );
  const transferId = inserted.insertId!;
  await lockVersion(command.transaction, "inventory_transfer", transferId);
  const approvalNo = `APR-${transferNo}`;
  const approval = await command.transaction.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'warehouse_transfer', 'inventory_transfer', ?, ?, ?, 0, 'pending', ?,
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [approvalNo, transferId, `Warehouse transfer ${transferNo}`, JSON.stringify({ fromWarehouseId, toWarehouseId, sku, quantity, reason }), command.access.userId],
  );
  await audit(command.transaction, command.access, command.request, {
    action: "create", module: "inventory", entityType: "inventory_transfer", entityId: transferId,
    businessNo: transferNo, after: { fromWarehouseId, toWarehouseId, sku, quantity, reason, approvalId: approval.insertId },
  });
  await domainEvent(context, command.transaction, {
    type: "ApprovalRequested", aggregateType: "inventory_transfer", aggregateId: transferId,
    payload: { approvalId: approval.insertId!, workflowType: "warehouse_transfer" },
  });
  return { transfer: { id: transferId, transferNo, fromWarehouseId, toWarehouseId, sku, quantity, reason, status: "pending_supply_chain" } };
}

export async function transitionTransfer(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const id = integer(body.id, "id");
  const action = oneOf(body.action, ["ship", "receive"] as const, "action");
  const rows = await command.transaction.query<Row>(
    `SELECT id, transfer_no AS transferNo, from_warehouse_id AS fromWarehouseId,
            to_warehouse_id AS toWarehouseId, sku, quantity, status
     FROM inventory_transfers WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const transfer = rows[0];
  if (transfer === undefined) throw new PlatformError(404, "NOT_FOUND", "Transfer not found");
  const version = await lockVersion(command.transaction, "inventory_transfer", id);
  const warehouseId = Number(action === "ship" ? transfer.fromWarehouseId : transfer.toWarehouseId);
  await requireWarehouseScope(command.transaction, command.access, warehouseId);
  if (await freezeExists(command.transaction, warehouseId, String(transfer.sku))) {
    throw new PlatformError(409, "CONFLICT", "Inventory is frozen by an active stocktake");
  }
  if (action === "ship") {
    if (transfer.status !== "approved") throw new PlatformError(409, "CONFLICT", "Transfer is not approved");
    const batches = await command.transaction.query<Row>(
      `SELECT id, available_quantity AS availableQuantity
       FROM inventory_batches
       WHERE warehouse_id = ? AND sku = ? AND ownership = 'company'
         AND available_quantity > 0 AND expiry_status <> 'expired_frozen' AND quarantine_quantity = 0
       ORDER BY expiry_date ASC, inbound_date ASC, id ASC FOR UPDATE`,
      [transfer.fromWarehouseId, transfer.sku],
    );
    let remaining = Number(transfer.quantity);
    const deductions: Array<{ id: number; quantity: number }> = [];
    for (const batch of batches) {
      if (remaining === 0) break;
      const quantity = Math.min(remaining, Number(batch.availableQuantity));
      deductions.push({ id: Number(batch.id), quantity });
      remaining -= quantity;
    }
    if (remaining !== 0) throw new PlatformError(409, "CONFLICT", "Insufficient available inventory");
    const claimed = await command.transaction.execute(
      `UPDATE inventory_transfers SET status = 'shipped', shipped_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'approved'`, [id],
    );
    if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Transfer changed concurrently");
    for (const deduction of deductions) {
      const updated = await command.transaction.execute(
        `UPDATE inventory_batches SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND available_quantity >= ?`, [deduction.quantity, deduction.id, deduction.quantity],
      );
      if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory changed concurrently");
    }
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
       VALUES (?, ?, 'transfer_out', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [transfer.fromWarehouseId, transfer.sku, -Number(transfer.quantity), `transfer:${id}:out`, command.access.userId],
    );
  } else {
    if (transfer.status !== "shipped") throw new PlatformError(409, "CONFLICT", "Only shipped transfers can be received");
    const claimed = await command.transaction.execute(
      `UPDATE inventory_transfers SET status = 'received', received_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'shipped'`, [id],
    );
    if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Transfer changed concurrently");
    await command.transaction.execute(
      `INSERT INTO inventory_batches (
         batch_no, warehouse_id, sku, inbound_date, available_quantity, ownership, expiry_status, created_at, updated_at
       ) VALUES (?, ?, ?, CURRENT_DATE(), ?, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [`${transfer.transferNo}-IN`, transfer.toWarehouseId, transfer.sku, transfer.quantity],
    );
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
       VALUES (?, ?, 'transfer_in', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [transfer.toWarehouseId, transfer.sku, transfer.quantity, `transfer:${id}:in`, command.access.userId],
    );
  }
  const nextVersion = await bumpVersion(command.transaction, "inventory_transfer", id, version);
  await audit(command.transaction, command.access, command.request, {
    action, module: "inventory", entityType: "inventory_transfer", entityId: id,
    businessNo: String(transfer.transferNo), before: transfer, after: { status: action === "ship" ? "shipped" : "received", version: nextVersion },
  });
  await domainEvent(context, command.transaction, {
    type: action === "ship" ? "TransferShipped" : "TransferReceived",
    aggregateType: "inventory_transfer", aggregateId: id,
  });
  return { success: true, id, status: action === "ship" ? "shipped" : "received", version: nextVersion };
}

export async function warehouseCommand(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain"]);
  const body = jsonObject(raw);
  const action = oneOf(body.action, ["create", "request_merge", "deactivate"] as const, "action");
  if (action === "create") {
    const code = string(body.code, "code", 191).toUpperCase();
    const name = string(body.name, "name");
    const type = oneOf(body.type, ["factory", "company", "other"] as const, "type");
    const factoryId = optionalInteger(body.factoryId, "factoryId");
    if (type === "factory" && factoryId === null) throw new PlatformError(400, "BAD_REQUEST", "Factory warehouse requires a factory binding");
    const inserted = await command.transaction.execute(
      `INSERT INTO warehouses (code, name, type, factory_id, address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [code, name, type, factoryId, optionalString(body.address)],
    );
    const id = inserted.insertId!;
    await lockVersion(command.transaction, "warehouse", id);
    await audit(command.transaction, command.access, command.request, {
      action: "create", module: "warehouse_master", entityType: "warehouse", entityId: id,
      businessNo: code, after: { code, name, type, factoryId },
    });
    await domainEvent(context, command.transaction, { type: "WarehouseCreated", aggregateType: "warehouse", aggregateId: id });
    return { warehouse: { id, code, name, type, factoryId, status: "active", version: 1 } };
  }
  const id = integer(body.id, "id");
  const rows = await command.transaction.query<Row>(
    `SELECT id, code, name, type, factory_id AS factoryId, status FROM warehouses WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const warehouse = rows[0];
  if (warehouse === undefined) throw new PlatformError(404, "NOT_FOUND", "Warehouse not found");
  const version = await lockVersion(command.transaction, "warehouse", id);
  if (warehouse.status !== "active") throw new PlatformError(409, "CONFLICT", "Warehouse is not active");
  if (action === "request_merge") {
    const targetId = integer(body.targetId, "targetId");
    const reason = string(body.reason, "reason");
    if (targetId === id) throw new PlatformError(400, "BAD_REQUEST", "Merge target must differ");
    const targets = await command.transaction.query<Row>(
      `SELECT id, name, status FROM warehouses WHERE id = ? LIMIT 1 FOR UPDATE`, [targetId],
    );
    if (targets[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Target warehouse not found");
    if (targets[0].status !== "active") throw new PlatformError(409, "CONFLICT", "Target warehouse is not active");
    const approvalNo = `AP-WHM-${randomUUID()}`;
    const approval = await command.transaction.execute(
      `INSERT INTO approval_requests (
         request_no, workflow_type, entity_type, entity_id, summary, payload_json,
         high_risk, status, requested_by, requested_at, created_at, updated_at
       ) VALUES (?, 'warehouse_merge', 'warehouse', ?, ?, ?, 0, 'pending', ?,
                 CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [approvalNo, id, `Warehouse merge ${warehouse.name} -> ${targets[0].name}`, JSON.stringify({ sourceId: id, targetId, reason }), command.access.userId],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "submit_approval", module: "warehouse_master", entityType: "warehouse_merge", entityId: approval.insertId!,
      businessNo: approvalNo, after: { sourceId: id, targetId, reason },
    });
    await domainEvent(context, command.transaction, {
      type: "ApprovalRequested", aggregateType: "warehouse", aggregateId: id,
      deduplicationSuffix: approval.insertId!,
      payload: { approvalId: approval.insertId!, workflowType: "warehouse_merge" },
    });
    return { approval: { id: approval.insertId, requestNo: approvalNo }, approvalRequired: true, version };
  }
  const blockers = await command.transaction.query<Row>(
    `SELECT
       (SELECT COUNT(*) FROM inventory_batches WHERE warehouse_id = ? AND
          (available_quantity + locked_quantity + defective_quantity + pending_inspection_quantity + quarantine_quantity) <> 0) AS inventory,
       (SELECT COUNT(*) FROM inventory_transfers WHERE (from_warehouse_id = ? OR to_warehouse_id = ?)
          AND status IN ('pending_supply_chain','approved','shipped')) AS transfers,
       (SELECT COUNT(*) FROM stocktakes WHERE warehouse_id = ? AND status IN ('first_count','recount','pending_approval')) AS stocktakes`,
    [id, id, id, id],
  );
  const blocker = blockers[0] ?? {};
  if ([blocker.inventory, blocker.transfers, blocker.stocktakes].some((value) => Number(value) > 0)) {
    throw new PlatformError(409, "CONFLICT", "Warehouse has active blockers", { blockers: blocker });
  }
  const updated = await command.transaction.execute(
    `UPDATE warehouses SET status = 'inactive', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'active'`, [id],
  );
  if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Warehouse changed concurrently");
  const nextVersion = await bumpVersion(command.transaction, "warehouse", id, version);
  await audit(command.transaction, command.access, command.request, {
    action: "deactivate", module: "warehouse_master", entityType: "warehouse", entityId: id,
    businessNo: String(warehouse.code), before: warehouse, after: { status: "inactive", version: nextVersion },
  });
  await domainEvent(context, command.transaction, { type: "WarehouseDeactivated", aggregateType: "warehouse", aggregateId: id });
  return { success: true, id, status: "inactive", version: nextVersion };
}

export async function openStocktake(
  context: DomainRegistrationContext,
  command: R3CommandContext,
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
  command: R3CommandContext,
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
    payload: { approvalId: approval.insertId!, varianceLines: variances.length },
  });
  return { success: true, status: "pending_approval", approvalId: approval.insertId, version: nextVersion };
}
