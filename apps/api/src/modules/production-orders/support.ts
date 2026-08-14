import { PlatformError } from "../../errors.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import { internal, type Row } from "../../platform/operations-support.js";
import type { AccessContext } from "../auth/index.js";

export async function requireExecutionScope(
  transaction: QueryExecutor,
  access: AccessContext,
  executionOrderId: number,
): Promise<Row> {
  const rows = await transaction.query<Row>(
    `SELECT eo.*, oi.sku, oi.purchase_order_id AS purchaseOrderId,
            oi.unit_price_tax_included_minor AS unitPriceTaxIncludedMinor
     FROM execution_orders eo JOIN order_items oi ON oi.id = eo.order_item_id
     WHERE eo.id = ? LIMIT 1 FOR SHARE`,
    [executionOrderId],
  );
  const order = rows[0];
  if (order === undefined) throw new PlatformError(404, "NOT_FOUND", "Execution order not found");
  if (!internal(access) && (access.factoryId === null || order.factory_id !== access.factoryId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden execution scope");
  }
  return order;
}
