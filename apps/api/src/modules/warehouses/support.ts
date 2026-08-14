import { PlatformError } from "../../errors.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import { internal, type Row } from "../../platform/operations-support.js";
import type { AccessContext } from "../auth/index.js";

export async function requireWarehouseScope(
  transaction: QueryExecutor,
  access: AccessContext,
  warehouseId: number,
): Promise<Row> {
  const rows = await transaction.query<Row>(
    `SELECT id, code, name, type, factory_id AS factoryId, status
     FROM warehouses WHERE id = ? LIMIT 1 FOR SHARE`,
    [warehouseId],
  );
  const warehouse = rows[0];
  if (warehouse === undefined) throw new PlatformError(404, "NOT_FOUND", "Warehouse not found");
  if (!internal(access) && (access.factoryId === null || warehouse.factoryId !== access.factoryId)) {
    throw new PlatformError(403, "FORBIDDEN", "Forbidden warehouse scope");
  }
  return warehouse;
}
