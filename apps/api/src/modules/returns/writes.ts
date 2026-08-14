
import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import { requireCleanFile } from "../files/support.js";
import { requireShipmentRow } from "../shipments/support.js";
import { freezeExists, lockWarehouseFreeze } from "../stocktakes/support.js";
import { requireWarehouseScope } from "../warehouses/support.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  hasRole,
  integer,
  internal,
  jsonObject,
  lockVersion,
  oneOf,
  optionalString,
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";


export async function returnCommand(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
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
    const source = await requireShipmentRow(command, sourceDeliveryBatchId);
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
