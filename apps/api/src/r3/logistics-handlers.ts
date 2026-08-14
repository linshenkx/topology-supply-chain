import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../platform/registrations.js";
import { PlatformError } from "../errors.js";
import type { R3CommandContext } from "./command.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  freezeExists,
  hasRole,
  integer,
  internal,
  jsonObject,
  lockVersion,
  lockWarehouseFreeze,
  oneOf,
  optionalString,
  requireCleanFile,
  requireRole,
  requireWarehouseScope,
  string,
  type Row,
} from "./support.js";

function localDay(value: string): string {
  return value.slice(0, 10);
}

async function shipment(
  command: R3CommandContext,
  id: number,
): Promise<Row> {
  const rows = await command.transaction.query<Row>(
    `SELECT db.id, db.execution_order_id AS executionOrderId, db.batch_no AS batchNo,
            db.quantity, db.planned_ship_at AS plannedShipAt, db.shipped_at AS shippedAt,
            db.destination, db.status, db.requires_approval AS requiresApproval,
            eo.factory_id AS factoryId, eo.order_item_id AS orderItemId,
            oi.sku, oi.purchase_order_id AS purchaseOrderId,
            oi.unit_price_tax_included_minor AS unitPriceTaxIncludedMinor
     FROM delivery_batches db
     JOIN execution_orders eo ON eo.id = db.execution_order_id
     JOIN order_items oi ON oi.id = eo.order_item_id
     WHERE db.id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const result = rows[0];
  if (result === undefined) throw new PlatformError(404, "NOT_FOUND", "Shipment not found");
  return result;
}

function requireFactoryBinding(command: R3CommandContext, factoryId: number): void {
  if (!internal(command.access) && (command.access.factoryId === null || command.access.factoryId !== factoryId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden factory binding");
  }
}

export async function shipmentCommand(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const body = jsonObject(raw);
  const action = oneOf(body.action, ["create", "confirm", "ship", "receive", "resolve_exception"] as const, "action");
  if (action === "create") {
    requireRole(command.access, ["admin", "supply_chain"]);
    const executionOrderId = integer(body.executionOrderId, "executionOrderId");
    const batchNo = string(body.batchNo, "batchNo", 191);
    const quantity = integer(body.quantity, "quantity");
    const plannedShipAt = string(body.plannedShipAt, "plannedShipAt", 100);
    const destination = string(body.destination, "destination");
    const orders = await command.transaction.query<Row>(
      `SELECT id, planned_quantity AS plannedQuantity, completed_quantity AS completedQuantity
       FROM execution_orders WHERE id = ? LIMIT 1 FOR UPDATE`, [executionOrderId],
    );
    if (orders[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Execution order not found");
    const planned = await command.transaction.query<Row>(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM delivery_batches
       WHERE execution_order_id = ? AND status NOT IN ('cancelled','deviation_rejected') FOR UPDATE`, [executionOrderId],
    );
    const availableToPlan = Math.max(Number(orders[0].completedQuantity), Number(orders[0].plannedQuantity));
    if (Number(planned[0]?.quantity ?? 0) + quantity > availableToPlan) {
      throw new PlatformError(409, "CONFLICT", "Shipment quantity exceeds the production quantity");
    }
    const inserted = await command.transaction.execute(
      `INSERT INTO delivery_batches (
         execution_order_id, batch_no, quantity, planned_ship_at, carrier, logistics_no,
         destination, requires_approval, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', '', ?, 0, 'pending_factory_confirmation', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [executionOrderId, batchNo, quantity, plannedShipAt, destination],
    );
    const id = inserted.insertId!;
    await lockVersion(command.transaction, "delivery_batch", id);
    await audit(command.transaction, command.access, command.request, {
      action: "create", module: "shipping", entityType: "delivery_batch", entityId: id,
      businessNo: batchNo, after: { executionOrderId, quantity, plannedShipAt, destination },
    });
    await domainEvent(context, command.transaction, {
      type: "ShipmentPlanned", aggregateType: "delivery_batch", aggregateId: id,
      payload: { executionOrderId, batchNo },
    });
    return { shipment: { id, executionOrderId, batchNo, quantity, plannedShipAt, destination, status: "pending_factory_confirmation", version: 1 } };
  }
  if (action === "resolve_exception") {
    requireRole(command.access, ["admin", "supply_chain"]);
    const exceptionId = integer(body.exceptionId, "exceptionId");
    const resolution = string(body.resolution, "resolution");
    const rows = await command.transaction.query<Row>(
      `SELECT id, execution_order_id AS executionOrderId, type, status, description
       FROM exceptions WHERE id = ? LIMIT 1 FOR UPDATE`, [exceptionId],
    );
    const exception = rows[0];
    if (exception === undefined || exception.type !== "logistics_exception") {
      throw new PlatformError(404, "NOT_FOUND", "Logistics exception not found");
    }
    if (exception.status === "resolved") throw new PlatformError(409, "CONFLICT", "Exception is already resolved");
    const version = await lockVersion(command.transaction, "logistics_exception", exceptionId);
    const updated = await command.transaction.execute(
      `UPDATE exceptions SET status = 'resolved', description = CONCAT(description, '\nResolution: ', ?), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status <> 'resolved'`, [resolution, exceptionId],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Exception changed concurrently");
    const nextVersion = await bumpVersion(command.transaction, "logistics_exception", exceptionId, version);
    await audit(command.transaction, command.access, command.request, {
      action: "resolve", module: "shipping", entityType: "logistics_exception", entityId: exceptionId,
      before: exception, after: { status: "resolved", resolution, version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "LogisticsExceptionResolved", aggregateType: "logistics_exception", aggregateId: exceptionId });
    return { exception: { id: exceptionId, status: "resolved", resolution, version: nextVersion } };
  }
  const id = integer(body.deliveryBatchId, "deliveryBatchId");
  const current = await shipment(command, id);
  const version = await lockVersion(command.transaction, "delivery_batch", id);
  if (action === "confirm") {
    requireRole(command.access, ["admin", "factory", "supply_chain"]);
    requireFactoryBinding(command, Number(current.factoryId));
    const updated = await command.transaction.execute(
      `UPDATE delivery_batches SET status = 'planned', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending_factory_confirmation'`, [id],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Shipment cannot be confirmed");
    const nextVersion = await bumpVersion(command.transaction, "delivery_batch", id, version);
    await audit(command.transaction, command.access, command.request, {
      action: "confirm", module: "shipping", entityType: "delivery_batch", entityId: id,
      businessNo: String(current.batchNo), before: { status: current.status }, after: { status: "planned", version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "ShipmentConfirmed", aggregateType: "delivery_batch", aggregateId: id });
    return { shipment: { id, status: "planned", version: nextVersion } };
  }
  if (action === "ship") {
    requireRole(command.access, ["admin", "factory", "supply_chain"]);
    requireFactoryBinding(command, Number(current.factoryId));
    if (!["planned", "approved_to_ship"].includes(String(current.status))) {
      throw new PlatformError(409, "CONFLICT", "Shipment cannot be dispatched from its current state");
    }
    const shippedAt = string(body.shippedAt, "shippedAt", 100);
    const carrier = string(body.carrier, "carrier");
    const logisticsNo = string(body.logisticsNo, "logisticsNo", 191);
    const file = await requireCleanFile(command.transaction, command.access, integer(body.evidenceFileId, "evidenceFileId"),
      { category: "shipment_evidence", entityType: "delivery_batch", entityId: id });
    if (localDay(String(current.plannedShipAt)) !== localDay(shippedAt) && current.status !== "approved_to_ship") {
      const reason = string(body.deviationReason, "deviationReason");
      const existing = await command.transaction.query<Row>(
        `SELECT id FROM approval_requests
         WHERE workflow_type = 'shipment_deviation' AND entity_id = ? AND status = 'pending'
         LIMIT 1 FOR UPDATE`, [id],
      );
      let approvalId = Number(existing[0]?.id);
      if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
        const approval = await command.transaction.execute(
          `INSERT INTO approval_requests (
             request_no, workflow_type, entity_type, entity_id, summary, payload_json,
             high_risk, status, requested_by, requested_at, created_at, updated_at
           ) VALUES (?, 'shipment_deviation', 'delivery_batch', ?, ?, ?, 0, 'pending', ?,
                     CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
          [`AP-SHIP-${randomUUID()}`, id, `Shipment deviation ${current.batchNo}`,
           JSON.stringify({ plannedShipAt: current.plannedShipAt, shippedAt, reason }), command.access.userId],
        );
        approvalId = approval.insertId!;
      }
      await command.transaction.execute(
        `UPDATE delivery_batches
         SET requires_approval = 1, deviation_reason = ?, status = 'pending_supply_chain', updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'planned'`, [reason, id],
      );
      const nextVersion = await bumpVersion(command.transaction, "delivery_batch", id, version);
      await audit(command.transaction, command.access, command.request, {
        action: "request_deviation", module: "shipping", entityType: "delivery_batch", entityId: id,
        businessNo: String(current.batchNo), after: { approvalId, status: "pending_supply_chain", version: nextVersion },
      });
      await domainEvent(context, command.transaction, {
        type: "ShipmentDeviationRequested", aggregateType: "delivery_batch", aggregateId: id,
        payload: { approvalId },
      });
      return { approvalRequired: true, approvalId, status: "pending_supply_chain", version: nextVersion };
    }
    const warehouses = await command.transaction.query<Row>(
      `SELECT id FROM warehouses WHERE factory_id = ? AND status = 'active' ORDER BY id ASC FOR SHARE`, [current.factoryId],
    );
    if (warehouses.length === 0) throw new PlatformError(409, "CONFLICT", "Factory has no active warehouse");
    const warehouseIds = warehouses.map((row) => Number(row.id));
    for (const warehouseId of [...warehouseIds].sort((a, b) => a - b)) {
      await lockWarehouseFreeze(command.transaction, warehouseId);
      if (await freezeExists(command.transaction, warehouseId, String(current.sku))) {
        throw new PlatformError(409, "CONFLICT", "Shipment warehouse is frozen by a stocktake");
      }
    }
    const placeholders = warehouseIds.map(() => "?").join(",");
    const batches = await command.transaction.query<Row>(
      `SELECT id, warehouse_id AS warehouseId, available_quantity AS availableQuantity
       FROM inventory_batches
       WHERE warehouse_id IN (${placeholders}) AND sku = ? AND ownership = 'company'
         AND available_quantity > 0 AND expiry_status <> 'expired_frozen' AND quarantine_quantity = 0
       ORDER BY expiry_date ASC, inbound_date ASC, id ASC FOR UPDATE`,
      [...warehouseIds, current.sku] as never,
    );
    let remaining = Number(current.quantity);
    const deductions: Array<{ id: number; warehouseId: number; quantity: number }> = [];
    for (const batch of batches) {
      if (remaining === 0) break;
      const quantity = Math.min(remaining, Number(batch.availableQuantity));
      deductions.push({ id: Number(batch.id), warehouseId: Number(batch.warehouseId), quantity });
      remaining -= quantity;
    }
    if (remaining !== 0) throw new PlatformError(409, "CONFLICT", "Insufficient released inventory");
    const claimed = await command.transaction.execute(
      `UPDATE delivery_batches
       SET shipped_at = ?, carrier = ?, logistics_no = ?, status = 'shipped', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status IN ('planned','approved_to_ship')`, [shippedAt, carrier, logisticsNo, id],
    );
    if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Shipment changed concurrently");
    for (const deduction of deductions) {
      const updated = await command.transaction.execute(
        `UPDATE inventory_batches SET available_quantity = available_quantity - ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND available_quantity >= ?`, [deduction.quantity, deduction.id, deduction.quantity],
      );
      if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Inventory changed concurrently");
      await command.transaction.execute(
        `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, delivery_batch_id, source_key, occurred_at, created_by)
         VALUES (?, ?, 'shipment', ?, ?, ?, ?, ?)`,
        [deduction.warehouseId, current.sku, -deduction.quantity, id,
         `shipment:${id}:batch:${deduction.id}`, shippedAt, command.access.userId],
      );
    }
    await command.transaction.execute(
      `INSERT INTO shipment_evidence (delivery_batch_id, file_key, file_name, created_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))`,
      [id, file.objectKey, optionalString(body.evidenceFileName, 500) || "shipment evidence"],
    );
    const nextVersion = await bumpVersion(command.transaction, "delivery_batch", id, version);
    await audit(command.transaction, command.access, command.request, {
      action: "ship", module: "shipping", entityType: "delivery_batch", entityId: id,
      businessNo: String(current.batchNo), before: current,
      after: { status: "shipped", shippedAt, carrier, logisticsNo, quantity: current.quantity, fileId: file.id, version: nextVersion },
    });
    await domainEvent(context, command.transaction, {
      type: "ShipmentDispatched", aggregateType: "delivery_batch", aggregateId: id,
      payload: { quantity: Number(current.quantity), purchaseOrderId: Number(current.purchaseOrderId) },
    });
    await domainEvent(context, command.transaction, {
      type: "PayableAccrued", aggregateType: "delivery_batch", aggregateId: id,
      payload: { purchaseOrderId: Number(current.purchaseOrderId), amountMinor: Number(current.quantity) * Number(current.unitPriceTaxIncludedMinor) },
    });
    return { success: true, id, status: "shipped", deductedQuantity: current.quantity, version: nextVersion };
  }
  requireRole(command.access, ["admin", "receiver"]);
  if (!hasRole(command.access, ["admin"])) {
    // Scope A deliberately does not invent receiver_org_id. Until an authoritative
    // receiver binding exists, a receiver-only account fails closed.
    throw new PlatformError(403, "FORBIDDEN", "Receiver organization binding is unavailable");
  }
  if (current.status !== "shipped") throw new PlatformError(409, "CONFLICT", "Only shipped batches can be received");
  const receivedQuantity = integer(body.receivedQuantity, "receivedQuantity", 0);
  const damagedQuantity = integer(body.damagedQuantity, "damagedQuantity", 0);
  const receivedAt = string(body.receivedAt, "receivedAt", 100);
  const file = await requireCleanFile(command.transaction, command.access, integer(body.receiptEvidenceFileId, "receiptEvidenceFileId"),
    { category: "receipt_evidence", entityType: "delivery_batch", entityId: id });
  if (receivedQuantity > Number(current.quantity) || damagedQuantity > receivedQuantity) {
    throw new PlatformError(409, "CONFLICT", "Receipt quantities exceed the shipment quantity");
  }
  const hasException = receivedQuantity < Number(current.quantity) || damagedQuantity > 0;
  const reason = optionalString(body.exceptionReason);
  if (hasException && reason.length === 0) throw new PlatformError(400, "BAD_REQUEST", "Exception reason is required");
  const receipt = await command.transaction.execute(
    `INSERT INTO shipment_receipts (
       delivery_batch_id, received_quantity, damaged_quantity, received_at,
       evidence_file_key, exception_reason, received_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [id, receivedQuantity, damagedQuantity, receivedAt, file.objectKey, reason, command.access.userId],
  );
  let exceptionId: number | undefined;
  if (hasException) {
    const exception = await command.transaction.execute(
      `INSERT INTO exceptions (
         execution_order_id, type, description, evidence_file_key, status, submitted_by, created_at, updated_at
       ) VALUES (?, 'logistics_exception', ?, ?, 'pending_supply_chain', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [current.executionOrderId, `${current.batchNo}: shipped ${current.quantity}, received ${receivedQuantity}, damaged ${damagedQuantity}. ${reason}`,
       file.objectKey, command.access.userId],
    );
    exceptionId = exception.insertId!;
    await lockVersion(command.transaction, "logistics_exception", exceptionId);
  }
  const claimed = await command.transaction.execute(
    `UPDATE delivery_batches SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'shipped'`, [hasException ? "received_with_exception" : "received", id],
  );
  if (claimed.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Shipment changed concurrently");
  const nextVersion = await bumpVersion(command.transaction, "delivery_batch", id, version);
  await audit(command.transaction, command.access, command.request, {
    action: "receive", module: "shipping", entityType: "shipment_receipt", entityId: receipt.insertId!,
    businessNo: String(current.batchNo), after: { receivedQuantity, damagedQuantity, receivedAt, fileId: file.id, exceptionId },
  });
  await domainEvent(context, command.transaction, {
    type: hasException ? "LogisticsExceptionOpened" : "ShipmentReceived",
    aggregateType: "delivery_batch", aggregateId: id,
    payload: { receiptId: receipt.insertId!, ...(exceptionId === undefined ? {} : { exceptionId }) },
  });
  return { receipt: { id: receipt.insertId, deliveryBatchId: id, receivedQuantity, damagedQuantity, receivedAt },
    logisticsExceptionCreated: hasException, exceptionId, status: hasException ? "received_with_exception" : "received", version: nextVersion };
}

export async function returnCommand(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const body = jsonObject(raw);
  const action = oneOf(body.action, ["receive", "inspect", "propose", "review"] as const, "action");
  if (action === "receive") {
    requireRole(command.access, ["admin", "supply_chain"]);
    const returnNo = string(body.returnNo, "returnNo", 191);
    const sourceDeliveryBatchId = integer(body.sourceDeliveryBatchId, "sourceDeliveryBatchId");
    const warehouseId = integer(body.warehouseId, "warehouseId");
    const quantity = integer(body.quantity, "quantity");
    await requireWarehouseScope(command.transaction, command.access, warehouseId);
    const source = await shipment(command, sourceDeliveryBatchId);
    if (!["received", "received_with_exception"].includes(String(source.status))) {
      throw new PlatformError(409, "CONFLICT", "Only received shipments can be returned");
    }
    const receipts = await command.transaction.query<Row>(
      `SELECT id, received_quantity AS receivedQuantity FROM shipment_receipts
       WHERE delivery_batch_id = ? ORDER BY id ASC FOR UPDATE`, [sourceDeliveryBatchId],
    );
    const validReceived = receipts.reduce((sum, row) => sum + Number(row.receivedQuantity), 0);
    if (validReceived <= 0) throw new PlatformError(409, "CONFLICT", "Shipment has no valid receipt quantity");
    const prior = await command.transaction.query<Row>(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM product_returns
       WHERE source_delivery_batch_id = ? FOR UPDATE`, [sourceDeliveryBatchId],
    );
    if (Number(prior[0]?.quantity ?? 0) + quantity > validReceived) {
      throw new PlatformError(409, "CONFLICT", "Cumulative return quantity exceeds valid receipts");
    }
    if (await freezeExists(command.transaction, warehouseId, String(source.sku))) {
      throw new PlatformError(409, "CONFLICT", "Return warehouse is frozen by a stocktake");
    }
    const batch = await command.transaction.execute(
      `INSERT INTO inventory_batches (
         batch_no, warehouse_id, sku, inbound_date, quarantine_quantity, ownership, expiry_status, created_at, updated_at
       ) VALUES (?, ?, ?, CURRENT_DATE(), ?, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [`RETURN-${returnNo}`, warehouseId, source.sku, quantity],
    );
    const inserted = await command.transaction.execute(
      `INSERT INTO product_returns (
         return_no, source_delivery_batch_id, warehouse_id, sku, quantity, batch_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'quarantined', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [returnNo, sourceDeliveryBatchId, warehouseId, source.sku, quantity, batch.insertId],
    );
    const id = inserted.insertId!;
    await lockVersion(command.transaction, "product_return", id);
    await command.transaction.execute(
      `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, delivery_batch_id, source_key, occurred_at, created_by)
       VALUES (?, ?, 'return_quarantined', ?, ?, ?, CURRENT_TIMESTAMP(3), ?)`,
      [warehouseId, source.sku, quantity, sourceDeliveryBatchId, `return:${id}:quarantined`, command.access.userId],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "receive", module: "returns", entityType: "product_return", entityId: id,
      businessNo: returnNo, after: { sourceDeliveryBatchId, warehouseId, quantity, batchId: batch.insertId },
    });
    await domainEvent(context, command.transaction, { type: "ReturnReceived", aggregateType: "product_return", aggregateId: id });
    return { return: { id, returnNo, sourceDeliveryBatchId, warehouseId, sku: source.sku, quantity, batchId: batch.insertId, status: "quarantined", version: 1 } };
  }
  const productReturnId = integer(body.productReturnId, "productReturnId");
  const rows = await command.transaction.query<Row>(
    `SELECT pr.*, db.execution_order_id AS executionOrderId, eo.factory_id AS factoryId,
            oi.supplier_id AS supplierId
     FROM product_returns pr JOIN delivery_batches db ON db.id = pr.source_delivery_batch_id
     JOIN execution_orders eo ON eo.id = db.execution_order_id
     JOIN order_items oi ON oi.id = eo.order_item_id
     WHERE pr.id = ? LIMIT 1 FOR UPDATE`, [productReturnId],
  );
  const record = rows[0];
  if (record === undefined) throw new PlatformError(404, "NOT_FOUND", "Return not found");
  const version = await lockVersion(command.transaction, "product_return", productReturnId);
  if (action === "inspect") {
    requireRole(command.access, ["admin", "company_qc", "supplier_qc"]);
    if (hasRole(command.access, ["supplier_qc"]) &&
        (command.access.supplierId === null || command.access.supplierId !== Number(record.supplierId))) {
      throw new PlatformError(403, "FORBIDDEN", "Forbidden supplier binding");
    }
    if (record.status !== "quarantined") throw new PlatformError(409, "CONFLICT", "Return is not awaiting inspection");
    const inspected = integer(body.inspectedQuantity, "inspectedQuantity");
    const passed = integer(body.passedQuantity, "passedQuantity", 0);
    const failed = integer(body.failedQuantity, "failedQuantity", 0);
    if (inspected !== Number(record.quantity) || passed + failed !== inspected) {
      throw new PlatformError(400, "BAD_REQUEST", "Return inspection quantities do not balance");
    }
    const reason = optionalString(body.defectReason);
    if (failed > 0 && reason.length === 0) throw new PlatformError(400, "BAD_REQUEST", "Defect reason is required");
    const file = await requireCleanFile(command.transaction, command.access, integer(body.evidenceFileId, "evidenceFileId"),
      { category: "quality_evidence", entityType: "product_return", entityId: productReturnId });
    const inserted = await command.transaction.execute(
      `INSERT INTO product_return_inspections (
         product_return_id, inspected_quantity, passed_quantity, failed_quantity,
         defect_reason, evidence_file_key, inspected_by, inspected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
      [productReturnId, inspected, passed, failed, reason, file.objectKey, command.access.userId],
    );
    await command.transaction.execute(
      `UPDATE product_returns SET status = 'pending_supply_chain', updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'quarantined'`, [productReturnId],
    );
    const nextVersion = await bumpVersion(command.transaction, "product_return", productReturnId, version);
    await audit(command.transaction, command.access, command.request, {
      action: "inspect", module: "returns", entityType: "product_return_inspection", entityId: inserted.insertId!,
      after: { productReturnId, inspected, passed, failed, reason, fileId: file.id },
    });
    await domainEvent(context, command.transaction, { type: "ReturnInspected", aggregateType: "product_return", aggregateId: productReturnId });
    return { inspection: { id: inserted.insertId, productReturnId, inspectedQuantity: inspected, passedQuantity: passed, failedQuantity: failed },
      status: "pending_supply_chain", version: nextVersion };
  }
  if (action === "propose") {
    requireRole(command.access, ["admin", "factory"]);
    if (!internal(command.access) &&
        (command.access.factoryId === null || command.access.factoryId !== Number(record.factoryId))) {
      throw new PlatformError(403, "FORBIDDEN", "Forbidden factory binding");
    }
    if (record.status !== "pending_supply_chain") throw new PlatformError(409, "CONFLICT", "Return is not awaiting disposition");
    if (!Array.isArray(body.dispositions)) throw new PlatformError(400, "BAD_REQUEST", "Dispositions are required");
    const dispositions = body.dispositions.map((value) => {
      const item = jsonObject(value);
      return { type: oneOf(item.type, ["restock", "rework", "scrap"] as const, "disposition type"), quantity: integer(item.quantity, "quantity", 0) };
    });
    const inspections = await command.transaction.query<Row>(
      `SELECT passed_quantity AS passedQuantity, failed_quantity AS failedQuantity
       FROM product_return_inspections WHERE product_return_id = ? ORDER BY id ASC FOR UPDATE`, [productReturnId],
    );
    if (inspections.length === 0) throw new PlatformError(409, "CONFLICT", "Return inspection is unavailable");
    const passed = inspections.reduce((sum, row) => sum + Number(row.passedQuantity), 0);
    const failed = inspections.reduce((sum, row) => sum + Number(row.failedQuantity), 0);
    const restock = dispositions.find((item) => item.type === "restock")?.quantity ?? 0;
    const failedDisposition = dispositions.filter((item) => item.type !== "restock").reduce((sum, item) => sum + item.quantity, 0);
    if (restock > passed || failedDisposition > failed) {
      throw new PlatformError(409, "CONFLICT", "Disposition exceeds authoritative inspection buckets");
    }
    if (new Set(dispositions.map((item) => item.type)).size !== dispositions.length ||
        dispositions.reduce((sum, item) => sum + item.quantity, 0) !== Number(record.quantity)) {
      throw new PlatformError(400, "BAD_REQUEST", "Disposition quantities do not balance");
    }
    const existing = await command.transaction.query<Row>(
      `SELECT id FROM product_return_dispositions WHERE product_return_id = ? LIMIT 1 FOR UPDATE`, [productReturnId],
    );
    if (existing.length > 0) throw new PlatformError(409, "CONFLICT", "Disposition was already proposed");
    for (const item of dispositions) {
      await command.transaction.execute(
        `INSERT INTO product_return_dispositions (
           product_return_id, type, quantity, status, proposed_by, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [productReturnId, item.type, item.quantity, command.access.userId],
      );
    }
    const nextVersion = await bumpVersion(command.transaction, "product_return", productReturnId, version);
    await audit(command.transaction, command.access, command.request, {
      action: "propose", module: "returns", entityType: "product_return", entityId: productReturnId,
      after: { dispositions, version: nextVersion },
    });
    await domainEvent(context, command.transaction, { type: "ReturnDispositionProposed", aggregateType: "product_return", aggregateId: productReturnId });
    return { success: true, productReturnId, dispositions, version: nextVersion };
  }
  requireRole(command.access, ["admin", "supply_chain"]);
  if (record.status !== "pending_supply_chain") throw new PlatformError(409, "CONFLICT", "Return is not awaiting review");
  const decision = oneOf(body.decision, ["approved", "rejected"] as const, "decision");
  const dispositions = await command.transaction.query<Row>(
    `SELECT id, type, quantity, proposed_by AS proposedBy, status
     FROM product_return_dispositions WHERE product_return_id = ? ORDER BY id ASC FOR UPDATE`, [productReturnId],
  );
  if (dispositions.length === 0) throw new PlatformError(409, "CONFLICT", "No disposition was proposed");
  if (dispositions.some((item) => Number(item.proposedBy) === command.access.userId)) {
    throw new PlatformError(409, "CONFLICT", "Proposer cannot review their own disposition");
  }
  for (const item of dispositions) {
    await command.transaction.execute(
      `UPDATE product_return_dispositions
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'pending'`, [decision, command.access.userId, item.id],
    );
  }
  if (decision === "approved") {
    await lockWarehouseFreeze(command.transaction, Number(record.warehouse_id));
    if (await freezeExists(command.transaction, Number(record.warehouse_id), String(record.sku))) {
      throw new PlatformError(409, "CONFLICT", "Return warehouse is frozen by a stocktake");
    }
    const restock = Number(dispositions.find((item) => item.type === "restock")?.quantity ?? 0);
    const updated = await command.transaction.execute(
      `UPDATE inventory_batches
       SET quarantine_quantity = quarantine_quantity - ?, available_quantity = available_quantity + ?,
           defective_quantity = defective_quantity + ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND quarantine_quantity >= ?`,
      [record.quantity, restock, Number(record.quantity) - restock, record.batch_id, record.quantity],
    );
    if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Return inventory changed concurrently");
    if (restock > 0) {
      await command.transaction.execute(
        `INSERT INTO inventory_movements (warehouse_id, sku, type, quantity, source_key, occurred_at, created_by)
         VALUES (?, ?, 'return_restock', ?, ?, CURRENT_TIMESTAMP(3), ?)`,
        [record.warehouse_id, record.sku, restock, `return:${productReturnId}:restock`, command.access.userId],
      );
    }
  }
  const updated = await command.transaction.execute(
    `UPDATE product_returns
     SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'pending_supply_chain'`,
    [decision === "approved" ? "restocked" : "inspection", command.access.userId, productReturnId],
  );
  if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Return changed concurrently");
  const nextVersion = await bumpVersion(command.transaction, "product_return", productReturnId, version);
  await audit(command.transaction, command.access, command.request, {
    action: decision, module: "returns", entityType: "product_return", entityId: productReturnId,
    businessNo: String(record.return_no), before: { status: record.status }, after: { status: decision === "approved" ? "restocked" : "inspection", version: nextVersion },
  });
  await domainEvent(context, command.transaction, {
    type: decision === "approved" ? "ReturnDispositionApproved" : "ReturnDispositionRejected",
    aggregateType: "product_return", aggregateId: productReturnId,
  });
  return { success: true, productReturnId, status: decision === "approved" ? "restocked" : "inspection", version: nextVersion };
}
