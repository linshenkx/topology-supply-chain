import {
  apiErrorSchemaId,
  shipmentsResponseSchema,
  shipmentsSchemaId,
  type Shipment,
  type ShipmentEvidence,
  type ShipmentException,
  type ShipmentExecution,
  type ShipmentOrderItem,
  type ShipmentReceipt,
  type ShipmentsResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain", "factory", "receiver"]);
const INTERNAL_ROLES = new Set(["supply_chain", "finance", "admin", "company_qc"]);
const SHIPMENT_LIMIT = 200;
const CHILD_LIMIT = 1_000;

type ShipmentsAccessContext = Pick<AccessContext, "factoryId" | "localPreview" | "organizationName" | "roles">;
type DataRow = Record<string, unknown>;
type ShipmentBase = Omit<Shipment, "execution" | "item" | "evidence" | "receipts" | "exceptions">;

export interface ShipmentsModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<ShipmentsAccessContext>;
  database?: QueryExecutor;
}

class ShipmentsForbiddenError extends Error { readonly statusCode = 403; }
class ShipmentsUnavailableError extends Error { readonly statusCode = 503; }
function invalidData(): never { throw new ShipmentsUnavailableError(); }
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalidData();
  return value;
}
function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalidData();
  return value;
}
function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return invalidData();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value, true); }
function nullablePositiveInteger(value: unknown): number | null { return value === null ? null : positiveInteger(value); }
function flag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidData();
}
function enumeration<const Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) return invalidData();
  return value as Value;
}
function bounded<Row>(rows: readonly Row[], maximum: number): readonly Row[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}
function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > SHIPMENT_LIMIT) return invalidData();
  return Array.from({ length: count }, () => "?").join(", ");
}

function shipment(row: DataRow): ShipmentBase {
  return {
    id: positiveInteger(row.id), executionOrderId: positiveInteger(row.executionOrderId),
    batchNo: text(row.batchNo), quantity: positiveInteger(row.quantity), plannedShipAt: text(row.plannedShipAt),
    shippedAt: nullableText(row.shippedAt), carrier: text(row.carrier, true), logisticsNo: text(row.logisticsNo, true),
    destination: text(row.destination, true), requiresApproval: flag(row.requiresApproval),
    deviationReason: nullableText(row.deviationReason), status: text(row.status),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function execution(row: DataRow): ShipmentExecution {
  return {
    id: positiveInteger(row.id), executionNo: text(row.executionNo), orderItemId: positiveInteger(row.orderItemId),
    factoryId: positiveInteger(row.factoryId), bomId: nullablePositiveInteger(row.bomId),
    plannedQuantity: positiveInteger(row.plannedQuantity), completedQuantity: nonNegativeInteger(row.completedQuantity),
    status: text(row.status), dueDate: nullableText(row.dueDate), plannedStartDate: nullableText(row.plannedStartDate),
    plannedFinishDate: nullableText(row.plannedFinishDate), actualStartAt: nullableText(row.actualStartAt),
    actualFinishAt: nullableText(row.actualFinishAt), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function item(row: DataRow): ShipmentOrderItem {
  return {
    id: positiveInteger(row.id), purchaseOrderId: positiveInteger(row.purchaseOrderId), sku: text(row.sku),
    productName: text(row.productName), itemType: enumeration(row.itemType, ["finished", "auxiliary", "component"]),
    supplierId: nullablePositiveInteger(row.supplierId), quantity: positiveInteger(row.quantity),
    unitPriceTaxIncludedMinor: nonNegativeInteger(row.unitPriceTaxIncludedMinor),
    amountTaxIncludedMinor: nonNegativeInteger(row.amountTaxIncludedMinor), dueDate: nullableText(row.dueDate),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function evidence(row: DataRow): ShipmentEvidence {
  return {
    id: positiveInteger(row.id), deliveryBatchId: positiveInteger(row.deliveryBatchId),
    fileKey: text(row.fileKey), fileName: text(row.fileName), createdAt: text(row.createdAt),
  };
}
function receipt(row: DataRow): ShipmentReceipt {
  return {
    id: positiveInteger(row.id), deliveryBatchId: positiveInteger(row.deliveryBatchId),
    receivedQuantity: nonNegativeInteger(row.receivedQuantity), damagedQuantity: nonNegativeInteger(row.damagedQuantity),
    receivedAt: text(row.receivedAt), evidenceFileKey: text(row.evidenceFileKey),
    exceptionReason: text(row.exceptionReason, true), receivedBy: positiveInteger(row.receivedBy),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function exception(row: DataRow): ShipmentException {
  return {
    id: positiveInteger(row.id), executionOrderId: positiveInteger(row.executionOrderId),
    factoryId: nullablePositiveInteger(row.factoryId), type: enumeration(row.type, ["logistics_exception"]),
    description: text(row.description), evidenceFileKey: nullableText(row.evidenceFileKey),
    status: text(row.status), submittedBy: positiveInteger(row.submittedBy),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}

const SHIPMENT_COLUMNS = `SELECT id, execution_order_id AS executionOrderId, batch_no AS batchNo,
  quantity, planned_ship_at AS plannedShipAt, shipped_at AS shippedAt, carrier,
  logistics_no AS logisticsNo, destination, requires_approval AS requiresApproval,
  deviation_reason AS deviationReason, status, created_at AS createdAt, updated_at AS updatedAt
FROM delivery_batches`;
const EXECUTION_COLUMNS = `SELECT id, execution_no AS executionNo, order_item_id AS orderItemId,
  factory_id AS factoryId, bom_id AS bomId, planned_quantity AS plannedQuantity,
  completed_quantity AS completedQuantity, status, due_date AS dueDate,
  planned_start_date AS plannedStartDate, planned_finish_date AS plannedFinishDate,
  actual_start_at AS actualStartAt, actual_finish_at AS actualFinishAt,
  created_at AS createdAt, updated_at AS updatedAt FROM execution_orders`;
const ITEM_COLUMNS = `SELECT id, purchase_order_id AS purchaseOrderId, sku, product_name AS productName,
  item_type AS itemType, supplier_id AS supplierId, quantity,
  unit_price_tax_included_minor AS unitPriceTaxIncludedMinor,
  amount_tax_included_minor AS amountTaxIncludedMinor, due_date AS dueDate,
  created_at AS createdAt, updated_at AS updatedAt FROM order_items`;
const EVIDENCE_COLUMNS = `SELECT id, delivery_batch_id AS deliveryBatchId, file_key AS fileKey,
  file_name AS fileName, created_at AS createdAt FROM shipment_evidence`;
const RECEIPT_COLUMNS = `SELECT id, delivery_batch_id AS deliveryBatchId,
  received_quantity AS receivedQuantity, damaged_quantity AS damagedQuantity,
  received_at AS receivedAt, evidence_file_key AS evidenceFileKey,
  exception_reason AS exceptionReason, received_by AS receivedBy,
  created_at AS createdAt, updated_at AS updatedAt FROM shipment_receipts`;
const EXCEPTION_COLUMNS = `SELECT id, execution_order_id AS executionOrderId,
  factory_id AS factoryId, type, description, evidence_file_key AS evidenceFileKey,
  status, submitted_by AS submittedBy, created_at AS createdAt, updated_at AS updatedAt
FROM exceptions`;

type ShipmentScope = { kind: "internal" } | { kind: "receiver"; organizationName: string } | { kind: "factory"; factoryId: number };
function resolveScope(context: ShipmentsAccessContext): ShipmentScope {
  if (!Array.isArray(context.roles) || !context.roles.some((role) => ALLOWED_ROLES.has(role))) throw new ShipmentsForbiddenError();
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) return { kind: "internal" };
  if (context.roles.includes("receiver")) {
    if (typeof context.organizationName !== "string" || context.organizationName.trim().length === 0) {
      throw new ShipmentsForbiddenError();
    }
    return { kind: "receiver", organizationName: context.organizationName.trim() };
  }
  if (context.roles.includes("factory") && Number.isSafeInteger(context.factoryId) && (context.factoryId ?? 0) > 0) {
    return { kind: "factory", factoryId: context.factoryId! };
  }
  throw new ShipmentsForbiddenError();
}

async function queryChildren<Row>(database: QueryExecutor, sql: string, ids: readonly number[], params: readonly (number | string)[] = ids): Promise<readonly Row[]> {
  if (ids.length === 0) return [];
  return bounded(await database.query<DataRow>(sql, params), CHILD_LIMIT) as readonly Row[];
}

async function readShipments(database: QueryExecutor, scope: ShipmentScope): Promise<ShipmentsResponse> {
  const scopedBaseQuery = scope.kind === "internal"
    ? { sql: SHIPMENT_COLUMNS, params: [] as readonly (number | string)[] }
    : scope.kind === "receiver"
      ? { sql: `${SHIPMENT_COLUMNS}\nWHERE BINARY TRIM(destination) = BINARY ?`, params: [scope.organizationName] }
      : {
          sql: `${SHIPMENT_COLUMNS}\nWHERE EXISTS (\n  SELECT 1 FROM execution_orders AS scoped_executions\n  WHERE scoped_executions.id = delivery_batches.execution_order_id\n    AND scoped_executions.factory_id = ?\n)`,
          params: [scope.factoryId],
        };
  const bases = bounded(await database.query<DataRow>(
    `${scopedBaseQuery.sql}\nORDER BY created_at DESC, id DESC\nLIMIT ${SHIPMENT_LIMIT}`,
    scopedBaseQuery.params,
  ), SHIPMENT_LIMIT).map(shipment);
  if (bases.length === 0) return { shipments: [] };
  const executionIds = Array.from(new Set(bases.map((row) => row.executionOrderId)));
  const executions = bounded(await database.query<DataRow>(
    `${EXECUTION_COLUMNS}\nWHERE id IN (${placeholders(executionIds.length)})\nORDER BY id ASC\nLIMIT ${SHIPMENT_LIMIT + 1}`,
    executionIds,
  ), SHIPMENT_LIMIT).map(execution);
  const executionById = new Map(executions.map((row) => [row.id, row]));
  if (executionById.size !== executionIds.length || executionIds.some((id) => !executionById.has(id))) return invalidData();

  const visible = bases.filter((row) => {
    const order = executionById.get(row.executionOrderId) ?? invalidData();
    if (scope.kind === "internal") return true;
    if (scope.kind === "receiver") {
      return Boolean(scope.organizationName) && row.destination.trim() === scope.organizationName.trim();
    }
    return order.factoryId === scope.factoryId;
  });
  if (visible.length === 0) return { shipments: [] };

  const visibleExecutionIds = Array.from(new Set(visible.map((row) => row.executionOrderId)));
  const visibleExecutions = visibleExecutionIds.map((id) => executionById.get(id) ?? invalidData());
  const itemIds = Array.from(new Set(visibleExecutions.map((row) => row.orderItemId)));
  const items = bounded(await database.query<DataRow>(
    `${ITEM_COLUMNS}\nWHERE id IN (${placeholders(itemIds.length)})\nORDER BY id ASC\nLIMIT ${SHIPMENT_LIMIT + 1}`,
    itemIds,
  ), SHIPMENT_LIMIT).map(item);
  const itemById = new Map(items.map((row) => [row.id, row]));
  if (itemById.size !== itemIds.length || itemIds.some((id) => !itemById.has(id))) return invalidData();

  const deliveryIds = visible.map((row) => row.id);
  const deliveryMarks = placeholders(deliveryIds.length);
  const executionMarks = placeholders(visibleExecutionIds.length);
  const [evidenceRows, receiptRows, exceptionRows] = await Promise.all([
    queryChildren<ShipmentEvidence>(database, `${EVIDENCE_COLUMNS}\nWHERE delivery_batch_id IN (${deliveryMarks})\nORDER BY delivery_batch_id ASC, id ASC\nLIMIT ${CHILD_LIMIT + 1}`, deliveryIds),
    queryChildren<ShipmentReceipt>(database, `${RECEIPT_COLUMNS}\nWHERE delivery_batch_id IN (${deliveryMarks})\nORDER BY delivery_batch_id ASC, id ASC\nLIMIT ${CHILD_LIMIT + 1}`, deliveryIds),
    queryChildren<ShipmentException>(database, `${EXCEPTION_COLUMNS}\nWHERE execution_order_id IN (${executionMarks}) AND type = ?\nORDER BY execution_order_id ASC, id ASC\nLIMIT ${CHILD_LIMIT + 1}`, visibleExecutionIds, [...visibleExecutionIds, "logistics_exception"]),
  ]);
  const evidenceValues = evidenceRows.map((row) => evidence(row as unknown as DataRow));
  const receiptValues = receiptRows.map((row) => receipt(row as unknown as DataRow));
  const exceptionValues = exceptionRows.map((row) => exception(row as unknown as DataRow));
  if (evidenceValues.some((row) => !deliveryIds.includes(row.deliveryBatchId)) || receiptValues.some((row) => !deliveryIds.includes(row.deliveryBatchId)) || exceptionValues.some((row) => !visibleExecutionIds.includes(row.executionOrderId))) return invalidData();

  return {
    shipments: visible.map((row) => {
      const currentExecution = executionById.get(row.executionOrderId) ?? invalidData();
      return {
        ...row,
        execution: currentExecution,
        item: itemById.get(currentExecution.orderItemId) ?? invalidData(),
        evidence: evidenceValues.filter((value) => value.deliveryBatchId === row.id),
        receipts: receiptValues.filter((value) => value.deliveryBatchId === row.id),
        exceptions: exceptionValues.filter((value) => value.executionOrderId === row.executionOrderId),
      };
    }),
  };
}

export async function registerShipmentsModule(app: FastifyInstance, options: ShipmentsModuleOptions): Promise<void> {
  if (!app.getSchema(shipmentsSchemaId)) app.addSchema(shipmentsResponseSchema);
  app.get<{ Reply: ShipmentsResponse }>(
    "/api/v1/shipments",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store"); reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie"); done();
      },
      schema: {
        tags: ["shipments"], summary: "Read scoped shipments",
        response: {
          200: { $ref: `${shipmentsSchemaId}#` }, 401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      const scope = resolveScope(access);
      if (access.localPreview) return { shipments: [], preview: true };
      if (options.database === undefined) throw new ShipmentsUnavailableError();
      try { return await readShipments(options.database, scope); }
      catch (error) {
        if (error instanceof ShipmentsForbiddenError) throw error;
        throw new ShipmentsUnavailableError();
      }
    },
  );
}
