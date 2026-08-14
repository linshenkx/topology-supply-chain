import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
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
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";

async function requireReservationEntityScope(
  command: OperationsCommandContext,
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
  command: OperationsCommandContext,
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
  command: OperationsCommandContext,
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
    recipient: { kind: "role", role: "supply_chain" },
    payload: { approvalId: approval.insertId!, workflowType: "warehouse_transfer" },
  });
  return { transfer: { id: transferId, transferNo, fromWarehouseId, toWarehouseId, sku, quantity, reason, status: "pending_supply_chain" } };
}

export async function transitionTransfer(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
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
