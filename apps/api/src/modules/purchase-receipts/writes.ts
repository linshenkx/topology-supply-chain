import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
import { requireWarehouseScope } from "../warehouses/support.js";
import {
  audit,
  domainEvent,
  integer,
  jsonObject,
  lockVersion,
  optionalString,
  requireRole,
  type Row,
} from "../../platform/operations-support.js";

export async function receivePurchase(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain", "factory"]);
  const body = jsonObject(raw);
  const purchaseOrderId = integer(body.purchaseOrderId, "purchaseOrderId");
  const orderItemId = integer(body.orderItemId, "orderItemId");
  const warehouseId = integer(body.warehouseId, "warehouseId");
  const receivedAt = optionalString(body.receivedAt) || new Date().toISOString();

  const items = await command.transaction.query<Row>(
    `SELECT oi.id, oi.purchase_order_id AS purchaseOrderId, oi.sku, oi.item_type AS itemType,
            oi.quantity, oi.received_quantity AS receivedQuantity, po.order_no AS orderNo
     FROM order_items oi
     JOIN purchase_orders po ON po.id = oi.purchase_order_id
     WHERE oi.id = ? AND oi.purchase_order_id = ? LIMIT 1 FOR UPDATE`,
    [orderItemId, purchaseOrderId],
  );
  const item = items[0];
  if (item === undefined) throw new PlatformError(404, "NOT_FOUND", "Purchase order item not found");
  if (Number(item.receivedQuantity) < 0 || Number(item.receivedQuantity) > Number(item.quantity)) {
    throw new PlatformError(409, "CONFLICT", "Purchase order item receipt state is invalid");
  }
  const remaining = Number(item.quantity) - Number(item.receivedQuantity);
  if (remaining <= 0) throw new PlatformError(409, "CONFLICT", "Purchase order item is already received");
  const receivedQuantity = body.receivedQuantity === undefined
    ? remaining
    : integer(body.receivedQuantity, "receivedQuantity");
  if (receivedQuantity !== remaining) {
    throw new PlatformError(400, "BAD_REQUEST", "Only full-batch receipt is supported");
  }

  await lockWarehouseFreeze(command.transaction, warehouseId);
  const warehouse = await requireWarehouseScope(command.transaction, command.access, warehouseId);
  if (warehouse.status !== "active") throw new PlatformError(409, "CONFLICT", "Receiving warehouse is not active");
  if (await freezeExists(command.transaction, warehouseId, String(item.sku))) {
    throw new PlatformError(409, "CONFLICT", "Receiving warehouse is frozen by an active stocktake");
  }

  const batchNo = `RCV-${String(item.orderNo)}-${orderItemId}-${randomUUID()}`;
  const batch = await command.transaction.execute(
    `INSERT INTO inventory_batches (
       batch_no, warehouse_id, sku, inbound_date, pending_inspection_quantity,
       ownership, expiry_status, created_at, updated_at
     ) VALUES (?, ?, ?, CURRENT_DATE(), ?, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [batchNo, warehouseId, item.sku, receivedQuantity],
  );
  const batchId = batch.insertId!;

  const receiptNo = `RC-${randomUUID()}`;
  const receipt = await command.transaction.execute(
    `INSERT INTO purchase_receipts (
       receipt_no, purchase_order_id, order_item_id, warehouse_id, batch_id,
       received_quantity, received_at, received_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [receiptNo, purchaseOrderId, orderItemId, warehouseId, batchId, receivedQuantity, receivedAt, command.access.userId],
  );
  const receiptId = receipt.insertId!;

  const updated = await command.transaction.execute(
    `UPDATE order_items
     SET received_quantity = received_quantity + ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND received_quantity + ? <= quantity`,
    [receivedQuantity, orderItemId, receivedQuantity],
  );
  if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Purchase order item changed concurrently");

  await command.transaction.execute(
    `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
     VALUES (?, ?, 'inbound', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
    [warehouseId, item.sku, receivedQuantity, `purchase_receipt:${receiptId}`, command.access.userId],
  );

  await lockVersion(command.transaction, "purchase_receipt", receiptId);
  await audit(command.transaction, command.access, command.request, {
    action: "receive", module: "purchase_receipts", entityType: "purchase_receipt", entityId: receiptId,
    businessNo: receiptNo, after: { purchaseOrderId, orderItemId, warehouseId, batchId, receivedQuantity },
  });
  await domainEvent(context, command.transaction, {
    type: "PurchaseOrderItemReceived", aggregateType: "purchase_receipt", aggregateId: receiptId,
    payload: { purchaseOrderId, orderItemId, warehouseId, batchId, receivedQuantity },
  });

  return { receipt: { id: receiptId, receiptNo, purchaseOrderId, orderItemId, warehouseId, batchId, receivedQuantity } };
}
