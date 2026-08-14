import { PlatformError } from "../../errors.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import { internal, type Row } from "../../platform/operations-support.js";
import { forbidden, isInternal, missing, type DataRow } from "../../platform/supply-support.js";
import type { AccessContext } from "../auth/index.js";

interface FileRow extends DataRow {
  category: string;
  factoryId: number | null;
  id: number;
  entityId: string | null;
  entityType: string | null;
  objectKey: string;
  ownerUserId: number;
  scanStatus: string;
  supplierId: number | null;
}

export async function requireFile(
  transaction: QueryExecutor,
  access: AccessContext,
  selector: { id?: number; objectKey?: string },
  categories?: readonly string[],
  entity?: { entityIds: readonly (number | string)[]; entityType: string },
): Promise<FileRow> {
  const useId = selector.id !== undefined;
  const value = useId ? selector.id : selector.objectKey;
  const rows = await transaction.query<FileRow>(
    `SELECT id, object_key AS objectKey, category, entity_type AS entityType,
            entity_id AS entityId, owner_user_id AS ownerUserId,
            factory_id AS factoryId, supplier_id AS supplierId, scan_status AS scanStatus
     FROM file_objects WHERE ${useId ? "id" : "object_key"} = ? LIMIT 1 FOR SHARE`,
    [value] as never[],
  );
  const row = rows[0];
  if (row === undefined || row.scanStatus !== "clean") return missing("Authorized clean file not found");
  if (categories !== undefined && !categories.includes(row.category)) return forbidden("File category rejected");
  if (entity !== undefined &&
      (row.entityType !== entity.entityType || row.entityId === null || !entity.entityIds.some((id) => String(id) === row.entityId))) {
    return forbidden("File entity binding rejected");
  }
  const scoped =
    isInternal(access) ||
    row.ownerUserId === access.userId ||
    (access.roles.includes("factory") && access.factoryId !== null && row.factoryId === access.factoryId) ||
    (access.roles.includes("supplier_qc") && access.supplierId !== null && row.supplierId === access.supplierId);
  if (!scoped) return forbidden("File scope rejected");
  return row;
}

export async function requireCleanFile(
  transaction: QueryExecutor,
  access: AccessContext,
  fileId: number,
  expected: { category: string; entityType: string; entityId: number | string },
): Promise<Row> {
  const rows = await transaction.query<Row>(
    `SELECT id, object_key AS objectKey, owner_user_id AS ownerUserId,
            factory_id AS factoryId, supplier_id AS supplierId, scan_status AS scanStatus,
            category, entity_type AS entityType, entity_id AS entityId
     FROM file_objects WHERE id = ? LIMIT 1 FOR UPDATE`,
    [fileId],
  );
  const file = rows[0];
  if (file === undefined) throw new PlatformError(404, "NOT_FOUND", "File not found");
  const scoped = file.ownerUserId === access.userId || internal(access) ||
    (access.factoryId !== null && file.factoryId === access.factoryId) ||
    (access.supplierId !== null && file.supplierId === access.supplierId);
  if (!scoped) throw new PlatformError(403, "FORBIDDEN", "Forbidden file scope");
  if (file.category !== expected.category || file.entityType !== expected.entityType ||
      String(file.entityId) !== String(expected.entityId)) {
    throw new PlatformError(403, "FORBIDDEN", "File is not bound to this object");
  }
  if (file.scanStatus !== "clean") throw new PlatformError(409, "FILE_QUARANTINED", "File is not ready");
  return file;
}
