import {
  apiErrorSchemaId,
  importDiffResponseSchema,
  importDiffSchemaId,
  type ImportDiffChanged,
  type ImportDiffJsonValue,
  type ImportDiffResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain"]);
const ROW_LIMIT = 5_000;
const FIELD_LIMIT = 500;

type ImportsAccessContext = Pick<AccessContext, "localPreview" | "roles">;
type DataRow = Record<string, unknown>;
type NormalizedImportRow = { [key: string]: ImportDiffJsonValue };

interface ImportDiffQuerystring {
  batchId: number;
}

interface StagingRow {
  id: number;
  importBatchId: number;
  sourceRowNo: number;
  businessKey: string | null;
  normalized: NormalizedImportRow;
}

export interface ImportsModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<ImportsAccessContext>;
  database?: QueryExecutor;
}

export class ImportsForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Import diff access forbidden");
    this.name = "ImportsForbiddenError";
  }
}

export class ImportsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Import diff unavailable");
    this.name = "ImportsUnavailableError";
  }
}

function invalidData(): never {
  throw new ImportsUnavailableError();
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return invalidData();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return invalidData();
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value);
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return invalidData();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalidData();
  return value;
}

function normalizedObject(value: string): NormalizedImportRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidData();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length > FIELD_LIMIT
  ) {
    return invalidData();
  }
  return parsed as NormalizedImportRow;
}

function stagingRow(row: DataRow, batchId: number): StagingRow {
  const importBatchId = positiveInteger(row.importBatchId);
  if (importBatchId !== batchId) return invalidData();
  return {
    id: positiveInteger(row.id),
    importBatchId,
    sourceRowNo: nonNegativeInteger(row.sourceRowNo),
    businessKey: nullableString(row.businessKey),
    normalized: normalizedObject(string(row.normalizedJson)),
  };
}

function requireAllowedRole(context: ImportsAccessContext): void {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new ImportsForbiddenError();
  }
}

async function readStagingRows(
  database: QueryExecutor,
  batchId: number,
): Promise<StagingRow[]> {
  const rows = await database.query<DataRow>(
    `SELECT
  id,
  import_batch_id AS importBatchId,
  source_row_no AS sourceRowNo,
  business_key AS businessKey,
  normalized_json AS normalizedJson
FROM import_staging_rows
WHERE import_batch_id = ?
ORDER BY source_row_no ASC, id ASC
LIMIT ${ROW_LIMIT + 1}`,
    [batchId],
  );
  if (rows.length > ROW_LIMIT) return invalidData();
  const ids = new Set<number>();
  return rows.map((row) => {
    const value = stagingRow(row, batchId);
    if (ids.has(value.id)) return invalidData();
    ids.add(value.id);
    return value;
  });
}

function keyedRows(
  rows: readonly StagingRow[],
): Map<string, NormalizedImportRow> {
  const values = new Map<string, NormalizedImportRow>();
  for (const row of rows) {
    const key = row.businessKey ?? String(row.sourceRowNo);
    if (values.has(key)) return invalidData();
    values.set(key, row.normalized);
  }
  return values;
}

function emptyDiff(): ImportDiffResponse {
  return { added: [], changed: [], removed: [] };
}

function createDiff(
  currentRows: readonly StagingRow[],
  previousRows: readonly StagingRow[],
): ImportDiffResponse {
  const current = keyedRows(currentRows);
  const previous = keyedRows(previousRows);
  const added: ImportDiffResponse["added"] = [];
  const changed: ImportDiffChanged[] = [];
  const removed: ImportDiffResponse["removed"] = [];

  for (const [key, value] of current) {
    const old = previous.get(key);
    if (old === undefined) {
      added.push({ key, value });
      continue;
    }
    const fieldNames = [
      ...new Set([...Object.keys(old), ...Object.keys(value)]),
    ];
    if (fieldNames.length > FIELD_LIMIT) return invalidData();
    const fields = fieldNames
      .filter(
        (field) =>
          JSON.stringify(old[field]) !== JSON.stringify(value[field]),
      )
      .map((field) => ({
        field,
        oldValue: old[field] ?? null,
        newValue: value[field] ?? null,
      }));
    if (fields.length > 0) changed.push({ key, fields });
  }
  for (const [key, value] of previous) {
    if (!current.has(key)) removed.push({ key, value });
  }
  return { added, changed, removed };
}

async function readImportDiff(
  database: QueryExecutor,
  batchId: number,
): Promise<ImportDiffResponse> {
  const batchRows = await database.query<DataRow>(
    `SELECT
  id,
  duplicate_of_batch_id AS duplicateOfBatchId
FROM import_batches
WHERE id = ?
ORDER BY id ASC
LIMIT 2`,
    [batchId],
  );
  if (batchRows.length > 1) return invalidData();
  const batch = batchRows[0];
  if (batch === undefined) return emptyDiff();
  if (positiveInteger(batch.id) !== batchId) return invalidData();
  const duplicateOfBatchId = nullablePositiveInteger(
    batch.duplicateOfBatchId,
  );
  if (duplicateOfBatchId === null) return emptyDiff();

  const [current, previous] = await Promise.all([
    readStagingRows(database, batchId),
    readStagingRows(database, duplicateOfBatchId),
  ]);
  return createDiff(current, previous);
}

export async function registerImportsModule(
  app: FastifyInstance,
  options: ImportsModuleOptions,
): Promise<void> {
  if (!app.getSchema(importDiffSchemaId)) {
    app.addSchema(importDiffResponseSchema);
  }

  app.get<{
    Querystring: ImportDiffQuerystring;
    Reply: ImportDiffResponse;
  }>(
    "/api/v1/imports/diff",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["imports"],
        summary: "Compare an import batch with its duplicate source batch",
        querystring: {
          type: "object",
          required: ["batchId"],
          properties: {
            batchId: { type: "integer", minimum: 1 },
          },
        },
        response: {
          200: { $ref: `${importDiffSchemaId}#` },
          400: { $ref: `${apiErrorSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      requireAllowedRole(access);
      if (access.localPreview) {
        return { ...emptyDiff(), preview: true };
      }
      if (options.database === undefined) {
        throw new ImportsUnavailableError();
      }

      try {
        return await readImportDiff(options.database, request.query.batchId);
      } catch {
        throw new ImportsUnavailableError();
      }
    },
  );
}
