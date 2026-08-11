import {
  apiErrorSchemaId,
  returnsResponseSchema,
  returnsSchemaId,
  type DeliveryBatch,
  type ProductReturn,
  type ProductReturnDisposition,
  type ProductReturnInspection,
  type ReturnsResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set([
  "admin",
  "supply_chain",
  "factory",
  "company_qc",
  "supplier_qc",
]);
const INTERNAL_ROLES = new Set(["admin", "supply_chain", "company_qc"]);
const RETURN_LIMIT = 200;
const INSPECTION_LIMIT = 1_000;
const DISPOSITION_LIMIT = 600;

const RETURN_COLUMNS = `SELECT
  returns.id,
  returns.return_no AS returnNo,
  returns.source_delivery_batch_id AS sourceDeliveryBatchId,
  returns.warehouse_id AS warehouseId,
  returns.sku,
  returns.quantity,
  returns.batch_id AS batchId,
  returns.status,
  returns.proposed_disposition AS proposedDisposition,
  returns.proposed_by AS proposedBy,
  returns.reviewed_by AS reviewedBy,
  returns.reviewed_at AS reviewedAt,
  returns.created_at AS createdAt,
  returns.updated_at AS updatedAt
FROM product_returns AS returns`;

const SHIPMENT_COLUMNS = `SELECT
  shipments.id,
  shipments.execution_order_id AS executionOrderId,
  shipments.batch_no AS batchNo,
  shipments.quantity,
  shipments.planned_ship_at AS plannedShipAt,
  shipments.shipped_at AS shippedAt,
  shipments.carrier,
  shipments.logistics_no AS logisticsNo,
  shipments.destination,
  shipments.requires_approval AS requiresApproval,
  shipments.deviation_reason AS deviationReason,
  shipments.status,
  shipments.created_at AS createdAt,
  shipments.updated_at AS updatedAt
FROM delivery_batches AS shipments`;

const INSPECTION_COLUMNS = `SELECT
  inspections.id,
  inspections.product_return_id AS productReturnId,
  inspections.inspected_quantity AS inspectedQuantity,
  inspections.passed_quantity AS passedQuantity,
  inspections.failed_quantity AS failedQuantity,
  inspections.defect_reason AS defectReason,
  inspections.evidence_file_key AS evidenceFileKey,
  inspections.inspected_by AS inspectedBy,
  inspections.inspected_at AS inspectedAt
FROM product_return_inspections AS inspections`;

const DISPOSITION_COLUMNS = `SELECT
  dispositions.id,
  dispositions.product_return_id AS productReturnId,
  dispositions.type,
  dispositions.quantity,
  dispositions.proposed_by AS proposedBy,
  dispositions.status,
  dispositions.reviewed_by AS reviewedBy,
  dispositions.reviewed_at AS reviewedAt,
  dispositions.created_at AS createdAt,
  dispositions.updated_at AS updatedAt
FROM product_return_dispositions AS dispositions`;

type ReturnsAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles" | "supplierId"
>;
type DataRow = Record<string, unknown>;
type ProductReturnBase = Omit<
  ProductReturn,
  "dispositions" | "inspections" | "sourceShipment"
>;
type ExecutionScopeRow = { id: number; factoryId: number; orderItemId: number };
type ItemScopeRow = { id: number; supplierId: number | null };

export interface ReturnsModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<ReturnsAccessContext>;
  database?: QueryExecutor;
}

export class ReturnsForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Returns access forbidden");
    this.name = "ReturnsForbiddenError";
  }
}

export class ReturnsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Returns unavailable");
    this.name = "ReturnsUnavailableError";
  }
}

function invalidData(): never {
  throw new ReturnsUnavailableError();
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

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value, true);
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

function nullableDisposition(
  value: unknown,
): "restock" | "rework" | "scrap" | null {
  return value === null
    ? null
    : enumeration(value, ["restock", "rework", "scrap"] as const);
}

function productReturn(row: DataRow): ProductReturnBase {
  return {
    id: positiveInteger(row.id),
    returnNo: string(row.returnNo),
    sourceDeliveryBatchId: positiveInteger(row.sourceDeliveryBatchId),
    warehouseId: positiveInteger(row.warehouseId),
    sku: string(row.sku),
    quantity: positiveInteger(row.quantity),
    batchId: nullablePositiveInteger(row.batchId),
    status: enumeration(row.status, [
      "return_in_transit",
      "quarantined",
      "inspection",
      "pending_supply_chain",
      "restocked",
      "rework",
      "scrapped",
    ] as const),
    proposedDisposition: nullableDisposition(row.proposedDisposition),
    proposedBy: nullablePositiveInteger(row.proposedBy),
    reviewedBy: nullablePositiveInteger(row.reviewedBy),
    reviewedAt: nullableString(row.reviewedAt),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function deliveryBatch(row: DataRow): DeliveryBatch {
  return {
    id: positiveInteger(row.id),
    executionOrderId: positiveInteger(row.executionOrderId),
    batchNo: string(row.batchNo),
    quantity: positiveInteger(row.quantity),
    plannedShipAt: string(row.plannedShipAt),
    shippedAt: nullableString(row.shippedAt),
    carrier: string(row.carrier, true),
    logisticsNo: string(row.logisticsNo, true),
    destination: string(row.destination, true),
    requiresApproval: boolean(row.requiresApproval),
    deviationReason: nullableString(row.deviationReason),
    status: string(row.status),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function returnInspection(row: DataRow): ProductReturnInspection {
  return {
    id: positiveInteger(row.id),
    productReturnId: positiveInteger(row.productReturnId),
    inspectedQuantity: positiveInteger(row.inspectedQuantity),
    passedQuantity: nonNegativeInteger(row.passedQuantity),
    failedQuantity: nonNegativeInteger(row.failedQuantity),
    defectReason: string(row.defectReason, true),
    evidenceFileKey: string(row.evidenceFileKey),
    inspectedBy: positiveInteger(row.inspectedBy),
    inspectedAt: string(row.inspectedAt),
  };
}

function returnDisposition(row: DataRow): ProductReturnDisposition {
  return {
    id: positiveInteger(row.id),
    productReturnId: positiveInteger(row.productReturnId),
    type: enumeration(row.type, ["restock", "rework", "scrap"] as const),
    quantity: nonNegativeInteger(row.quantity),
    proposedBy: positiveInteger(row.proposedBy),
    status: enumeration(row.status, [
      "pending_supply_chain",
      "approved",
      "rejected",
    ] as const),
    reviewedBy: nullablePositiveInteger(row.reviewedBy),
    reviewedAt: nullableString(row.reviewedAt),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function executionScope(row: DataRow): ExecutionScopeRow {
  return {
    id: positiveInteger(row.id),
    factoryId: positiveInteger(row.factoryId),
    orderItemId: positiveInteger(row.orderItemId),
  };
}

function itemScope(row: DataRow): ItemScopeRow {
  return {
    id: positiveInteger(row.id),
    supplierId: nullablePositiveInteger(row.supplierId),
  };
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > RETURN_LIMIT) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

function positiveOrganizationId(value: number | null): number | null {
  return Number.isSafeInteger(value) && value !== null && value > 0
    ? value
    : null;
}

function ensureRole(context: ReturnsAccessContext): void {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new ReturnsForbiddenError();
  }
}

function isInternal(context: ReturnsAccessContext): boolean {
  return context.roles.some((role) => INTERNAL_ROLES.has(role));
}

async function relatedRows<Value>(
  database: QueryExecutor,
  sql: string,
  ids: readonly number[],
  maximum: number,
  parse: (row: DataRow) => Value,
): Promise<Value[]> {
  if (ids.length === 0) return [];
  const rows = await database.query<DataRow>(sql, ids);
  if (rows.length > maximum) return invalidData();
  return rows.map(parse);
}

async function readReturns(
  database: QueryExecutor,
  access: ReturnsAccessContext,
): Promise<ProductReturn[]> {
  const returnRows = await database.query<DataRow>(
    `${RETURN_COLUMNS}
ORDER BY returns.created_at DESC, returns.id DESC
LIMIT ${RETURN_LIMIT}`,
  );
  if (returnRows.length > RETURN_LIMIT) return invalidData();
  const records = returnRows.map(productReturn);
  const shipmentIds = Array.from(
    new Set(records.map((record) => record.sourceDeliveryBatchId)),
  );
  const shipments = await relatedRows(
    database,
    shipmentIds.length === 0
      ? ""
      : `${SHIPMENT_COLUMNS}
WHERE shipments.id IN (${placeholders(shipmentIds.length)})
ORDER BY shipments.id ASC
LIMIT ${RETURN_LIMIT + 1}`,
    shipmentIds,
    RETURN_LIMIT,
    deliveryBatch,
  );
  const shipmentIdSet = new Set(shipmentIds);
  if (shipments.some((row) => !shipmentIdSet.has(row.id))) invalidData();
  const shipmentById = new Map(shipments.map((row) => [row.id, row]));

  let visible = records;
  if (!isInternal(access)) {
    const executionIds = Array.from(
      new Set(shipments.map((shipment) => shipment.executionOrderId)),
    );
    const executions = await relatedRows(
      database,
      executionIds.length === 0
        ? ""
        : `SELECT
  execution.id,
  execution.factory_id AS factoryId,
  execution.order_item_id AS orderItemId
FROM execution_orders AS execution
WHERE execution.id IN (${placeholders(executionIds.length)})
ORDER BY execution.id ASC
LIMIT ${RETURN_LIMIT + 1}`,
      executionIds,
      RETURN_LIMIT,
      executionScope,
    );
    const executionIdSet = new Set(executionIds);
    if (executions.some((row) => !executionIdSet.has(row.id))) invalidData();
    const executionById = new Map(executions.map((row) => [row.id, row]));
    const supplierId = positiveOrganizationId(access.supplierId);
    const itemIds =
      supplierId === null
        ? []
        : Array.from(new Set(executions.map((row) => row.orderItemId)));
    const items = await relatedRows(
      database,
      itemIds.length === 0
        ? ""
        : `SELECT item.id, item.supplier_id AS supplierId
FROM order_items AS item
WHERE item.id IN (${placeholders(itemIds.length)})
ORDER BY item.id ASC
LIMIT ${RETURN_LIMIT + 1}`,
      itemIds,
      RETURN_LIMIT,
      itemScope,
    );
    const itemIdSet = new Set(itemIds);
    if (items.some((row) => !itemIdSet.has(row.id))) invalidData();
    const itemById = new Map(items.map((row) => [row.id, row]));
    const factoryId = positiveOrganizationId(access.factoryId);

    visible = records.filter((record) => {
      const shipment = shipmentById.get(record.sourceDeliveryBatchId);
      const execution = shipment
        ? executionById.get(shipment.executionOrderId)
        : undefined;
      if (execution === undefined) return false;
      if (factoryId !== null && execution.factoryId === factoryId) return true;
      return (
        supplierId !== null &&
        itemById.get(execution.orderItemId)?.supplierId === supplierId
      );
    });
  }

  const visibleIds = visible.map((record) => record.id);
  const inspections = await relatedRows(
    database,
    visibleIds.length === 0
      ? ""
      : `${INSPECTION_COLUMNS}
WHERE inspections.product_return_id IN (${placeholders(visibleIds.length)})
ORDER BY inspections.product_return_id ASC, inspections.id ASC
LIMIT ${INSPECTION_LIMIT + 1}`,
    visibleIds,
    INSPECTION_LIMIT,
    returnInspection,
  );
  const dispositions = await relatedRows(
    database,
    visibleIds.length === 0
      ? ""
      : `${DISPOSITION_COLUMNS}
WHERE dispositions.product_return_id IN (${placeholders(visibleIds.length)})
ORDER BY dispositions.product_return_id ASC, dispositions.id ASC
LIMIT ${DISPOSITION_LIMIT + 1}`,
    visibleIds,
    DISPOSITION_LIMIT,
    returnDisposition,
  );
  const visibleSet = new Set(visibleIds);
  if (
    inspections.some((row) => !visibleSet.has(row.productReturnId)) ||
    dispositions.some((row) => !visibleSet.has(row.productReturnId))
  ) {
    return invalidData();
  }

  return visible.map((record) => ({
    ...record,
    sourceShipment: shipmentById.get(record.sourceDeliveryBatchId) ?? null,
    inspections: inspections.filter(
      (row) => row.productReturnId === record.id,
    ),
    dispositions: dispositions.filter(
      (row) => row.productReturnId === record.id,
    ),
  }));
}

export async function registerReturnsModule(
  app: FastifyInstance,
  options: ReturnsModuleOptions,
): Promise<void> {
  if (!app.getSchema(returnsSchemaId)) app.addSchema(returnsResponseSchema);

  app.get<{ Reply: ReturnsResponse }>(
    "/api/v1/returns",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["returns"],
        summary: "Read product returns",
        response: {
          200: { $ref: `${returnsSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      ensureRole(access);
      if (access.localPreview) return { returns: [], preview: true };
      if (options.database === undefined) throw new ReturnsUnavailableError();
      return { returns: await readReturns(options.database, access) };
    },
  );
}
