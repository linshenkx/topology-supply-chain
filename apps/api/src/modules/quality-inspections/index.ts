import {
  apiErrorSchemaId,
  qualityInspectionsResponseSchema,
  qualityInspectionsSchemaId,
  qualityPendingBatchesResponseSchema,
  qualityPendingBatchesSchemaId,
  type QualityInspection,
  type QualityInspectionsResponse,
  type QualityPendingBatch,
  type QualityPendingBatchesResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set([
  "admin",
  "supply_chain",
  "factory",
  "supplier_qc",
  "company_qc",
]);
const INTERNAL_ROLES = new Set(["admin", "supply_chain", "company_qc"]);
const INSPECTION_LIMIT = 200;
const PENDING_BATCH_ROLES = new Set(["admin", "company_qc"]);
const PENDING_BATCH_LIMIT = 200;

const INSPECTION_COLUMNS = `SELECT
  inspections.id,
  inspections.execution_order_id AS executionOrderId,
  inspections.batch_id AS batchId,
  inspections.stage,
  inspections.inspection_method AS inspectionMethod,
  inspections.batch_quantity AS batchQuantity,
  inspections.inspected_quantity AS inspectedQuantity,
  inspections.passed_quantity AS passedQuantity,
  inspections.failed_quantity AS failedQuantity,
  inspections.pass_rate_bps AS passRateBps,
  inspections.quality_rule_id AS qualityRuleId,
  inspections.used_item_type_fallback AS usedItemTypeFallback,
  inspections.sku_rule_reminder_status AS skuRuleReminderStatus,
  inspections.defect_reason AS defectReason,
  inspections.system_result AS systemResult,
  inspections.requested_result AS requestedResult,
  inspections.requires_approval AS requiresApproval,
  inspections.final_result AS finalResult,
  inspections.quarantine_triggered AS quarantineTriggered,
  inspections.full_inspection_required AS fullInspectionRequired,
  inspections.source_inspection_id AS sourceInspectionId,
  inspections.released_quantity AS releasedQuantity,
  inspections.disposition_status AS dispositionStatus,
  inspections.inspector_type AS inspectorType,
  inspections.submitted_by AS submittedBy,
  inspections.created_at AS createdAt,
  inspections.updated_at AS updatedAt
FROM quality_inspections AS inspections`;

type QualityAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles" | "supplierId"
>;
type DataRow = Record<string, unknown>;

type InspectionScope =
  | { kind: "internal" }
  | { kind: "factory"; factoryId: number }
  | { kind: "supplier"; supplierId: number }
  | { kind: "factory_supplier"; factoryId: number; supplierId: number };

export interface QualityInspectionsModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<QualityAccessContext>;
  database?: QueryExecutor;
}

export class QualityInspectionsForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Quality inspections access forbidden");
    this.name = "QualityInspectionsForbiddenError";
  }
}

export class QualityInspectionsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Quality inspections unavailable");
    this.name = "QualityInspectionsUnavailableError";
  }
}

function invalidData(): never {
  throw new QualityInspectionsUnavailableError();
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
  return value === null ? null : positiveInteger(value);
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidData();
}

function enumeration<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return invalidData();
  }
  return value as Value;
}

function nullableResult(value: unknown): "passed" | "failed" | null {
  return value === null
    ? null
    : enumeration(value, ["passed", "failed"] as const);
}

function nullableFinalResult(
  value: unknown,
): "passed" | "failed" | "pending_approval" | null {
  return value === null
    ? null
    : enumeration(value, [
        "passed",
        "failed",
        "pending_approval",
      ] as const);
}

function inspection(row: DataRow): QualityInspection {
  return {
    id: positiveInteger(row.id),
    executionOrderId: nullablePositiveInteger(row.executionOrderId),
    batchId: nullablePositiveInteger(row.batchId),
    stage: enumeration(row.stage, ["incoming", "finished_goods"] as const),
    inspectionMethod: enumeration(row.inspectionMethod, [
      "sampling",
      "full",
    ] as const),
    batchQuantity: positiveInteger(row.batchQuantity),
    inspectedQuantity: positiveInteger(row.inspectedQuantity),
    passedQuantity: nonNegativeInteger(row.passedQuantity),
    failedQuantity: nonNegativeInteger(row.failedQuantity),
    passRateBps: nonNegativeInteger(row.passRateBps),
    qualityRuleId: positiveInteger(row.qualityRuleId),
    usedItemTypeFallback: boolean(row.usedItemTypeFallback),
    skuRuleReminderStatus: enumeration(row.skuRuleReminderStatus, [
      "not_needed",
      "pending",
      "completed",
    ] as const),
    defectReason: string(row.defectReason, true),
    systemResult: enumeration(row.systemResult, ["passed", "failed"] as const),
    requestedResult: nullableResult(row.requestedResult),
    requiresApproval: boolean(row.requiresApproval),
    finalResult: nullableFinalResult(row.finalResult),
    quarantineTriggered: boolean(row.quarantineTriggered),
    fullInspectionRequired: boolean(row.fullInspectionRequired),
    sourceInspectionId: nullablePositiveInteger(row.sourceInspectionId),
    releasedQuantity: nonNegativeInteger(row.releasedQuantity),
    dispositionStatus: enumeration(row.dispositionStatus, [
      "not_needed",
      "pending",
      "completed",
    ] as const),
    inspectorType: enumeration(row.inspectorType, [
      "supplier_qc",
      "company_qc",
    ] as const),
    submittedBy: positiveInteger(row.submittedBy),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function pendingBatch(row: DataRow): QualityPendingBatch {
  return {
    batchId: positiveInteger(row.batchId),
    batchNo: string(row.batchNo),
    warehouseId: positiveInteger(row.warehouseId),
    warehouseName: string(row.warehouseName),
    sku: string(row.sku),
    pendingInspectionQuantity: positiveInteger(row.pendingInspectionQuantity),
    source: enumeration(row.source, ["receipt", "production"] as const),
    stage: enumeration(row.stage, ["incoming", "finished_goods"] as const),
  };
}

const PENDING_BATCH_COLUMNS = `SELECT
  b.id AS batchId,
  b.batch_no AS batchNo,
  b.warehouse_id AS warehouseId,
  w.name AS warehouseName,
  b.sku,
  b.pending_inspection_quantity AS pendingInspectionQuantity,
  CASE WHEN EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.batch_id = b.id)
       THEN 'receipt' ELSE 'production' END AS source,
  CASE WHEN EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.batch_id = b.id)
       THEN 'incoming' ELSE 'finished_goods' END AS stage
FROM inventory_batches b
JOIN warehouses w ON w.id = b.warehouse_id
WHERE b.pending_inspection_quantity > 0
  AND (
    (EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.batch_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM production_reports prod WHERE prod.batch_id = b.id))
    OR
    (NOT EXISTS (SELECT 1 FROM purchase_receipts pr WHERE pr.batch_id = b.id)
     AND EXISTS (SELECT 1 FROM production_reports prod WHERE prod.batch_id = b.id))
  )
ORDER BY b.created_at DESC, b.id DESC
LIMIT ${PENDING_BATCH_LIMIT}`;

async function readPendingBatches(
  database: QueryExecutor,
): Promise<QualityPendingBatch[]> {
  const rows = await database.query<DataRow>(PENDING_BATCH_COLUMNS);
  if (rows.length > PENDING_BATCH_LIMIT) return invalidData();
  return rows.map(pendingBatch);
}

function organizationId(value: number | null): number {
  if (!Number.isSafeInteger(value) || value === null || value <= 0) {
    throw new QualityInspectionsForbiddenError();
  }
  return value;
}

function resolveScope(context: QualityAccessContext): InspectionScope {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new QualityInspectionsForbiddenError();
  }
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) {
    return { kind: "internal" };
  }

  const hasFactoryRole = context.roles.includes("factory");
  const hasSupplierRole = context.roles.includes("supplier_qc");
  const factoryId = hasFactoryRole
    ? organizationId(context.factoryId)
    : undefined;
  const supplierId = hasSupplierRole
    ? organizationId(context.supplierId)
    : undefined;

  if (factoryId !== undefined && supplierId !== undefined) {
    return { kind: "factory_supplier", factoryId, supplierId };
  }
  if (factoryId !== undefined) return { kind: "factory", factoryId };
  if (supplierId !== undefined) return { kind: "supplier", supplierId };
  throw new QualityInspectionsForbiddenError();
}

async function readInspections(
  database: QueryExecutor,
  scope: InspectionScope,
): Promise<QualityInspection[]> {
  let where = "";
  let params: readonly number[] = [];

  if (scope.kind === "factory") {
    where = `
WHERE EXISTS (
  SELECT 1
  FROM execution_orders AS execution
  WHERE execution.id = inspections.execution_order_id
    AND execution.factory_id = ?
)`;
    params = [scope.factoryId];
  } else if (scope.kind === "supplier") {
    where = `
WHERE EXISTS (
  SELECT 1
  FROM execution_orders AS execution
  INNER JOIN order_items AS item ON item.id = execution.order_item_id
  WHERE execution.id = inspections.execution_order_id
    AND item.supplier_id = ?
)`;
    params = [scope.supplierId];
  } else if (scope.kind === "factory_supplier") {
    where = `
WHERE EXISTS (
  SELECT 1
  FROM execution_orders AS execution
  INNER JOIN order_items AS item ON item.id = execution.order_item_id
  WHERE execution.id = inspections.execution_order_id
    AND (execution.factory_id = ? OR item.supplier_id = ?)
)`;
    params = [scope.factoryId, scope.supplierId];
  }

  const rows = await database.query<DataRow>(
    `${INSPECTION_COLUMNS}${where}
ORDER BY inspections.created_at DESC, inspections.id DESC
LIMIT ${INSPECTION_LIMIT}`,
    params,
  );
  if (rows.length > INSPECTION_LIMIT) return invalidData();
  return rows.map(inspection);
}

export async function registerQualityInspectionsModule(
  app: FastifyInstance,
  options: QualityInspectionsModuleOptions,
): Promise<void> {
  if (!app.getSchema(qualityInspectionsSchemaId)) {
    app.addSchema(qualityInspectionsResponseSchema);
  }
  if (!app.getSchema(qualityPendingBatchesSchemaId)) {
    app.addSchema(qualityPendingBatchesResponseSchema);
  }

  app.get<{ Reply: QualityInspectionsResponse }>(
    "/api/v1/quality-inspections",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["quality-inspections"],
        summary: "Read quality inspections",
        response: {
          200: { $ref: `${qualityInspectionsSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      const scope = resolveScope(access);
      if (access.localPreview) return { inspections: [], preview: true };
      if (options.database === undefined) {
        throw new QualityInspectionsUnavailableError();
      }
      return { inspections: await readInspections(options.database, scope) };
    },
  );
  app.get<{ Reply: QualityPendingBatchesResponse }>(
    "/api/v1/quality-inspections/pending-batches",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["quality-inspections"],
        summary: "Read quality pending batches for company QC",
        response: {
          200: { $ref: `${qualityPendingBatchesSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (!access.roles.some((role) => PENDING_BATCH_ROLES.has(role))) {
        throw new QualityInspectionsForbiddenError();
      }
      if (access.localPreview) return { pendingBatches: [], preview: true };
      if (options.database === undefined) {
        throw new QualityInspectionsUnavailableError();
      }
      return { pendingBatches: await readPendingBatches(options.database) };
    },
  );
}
