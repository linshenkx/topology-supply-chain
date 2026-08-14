import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import type { Row } from "../../platform/operations-support.js";

export async function requireShipmentRow(
  command: OperationsCommandContext,
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
