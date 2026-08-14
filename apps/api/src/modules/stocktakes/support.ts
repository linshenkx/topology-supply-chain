import type { QueryExecutor } from "../../infrastructure/database.js";
import { lockVersion, type Row } from "../../platform/operations-support.js";

export async function lockWarehouseFreeze(transaction: QueryExecutor, warehouseId: number): Promise<void> {
  await lockVersion(transaction, "warehouse_inventory_freeze", warehouseId);
}

export async function freezeExists(
  transaction: QueryExecutor,
  warehouseId: number,
  sku?: string,
): Promise<boolean> {
  await lockWarehouseFreeze(transaction, warehouseId);
  const rows = await transaction.query<Row>(
    `SELECT 1 AS frozen FROM stocktakes s
     WHERE s.warehouse_id = ? AND s.status IN ('first_count', 'recount', 'pending_approval')
       AND (
         ? IS NULL OR s.scope = 'full_warehouse' OR EXISTS (
           SELECT 1 FROM stocktake_counts c
           WHERE c.stocktake_id = s.id AND c.count_round = 0 AND c.sku = ?
         )
       )
     LIMIT 1 FOR SHARE`,
    [warehouseId, sku ?? null, sku ?? null],
  );
  return rows.length > 0;
}
