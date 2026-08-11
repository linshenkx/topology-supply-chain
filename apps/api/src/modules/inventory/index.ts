import {
  apiErrorSchemaId,
  inventoryResponseSchema,
  inventorySchemaId,
  type InventoryBatch,
  type InventoryQuery,
  type InventoryReservation,
  type InventoryResponse,
  type InventoryTransfer,
  type InventoryWarehouse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain", "factory"]);
const INTERNAL_ROLES = new Set(["supply_chain", "finance", "admin", "company_qc"]);
const WAREHOUSE_LIMIT = 500;
const BATCH_LIMIT = 500;
const RESERVATION_LIMIT = 200;
const TRANSFER_LIMIT = 100;

type InventoryAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles" | "userId"
>;
type DataRow = Record<string, unknown>;

export interface InventoryAuditEvent {
  access: InventoryAccessContext;
  action: "view";
  module: "inventory";
  entityType: "inventory_batch";
  entityId: number | "all";
  sensitiveView: true;
  requestId: string;
  ipAddress: string | null;
  deviceId: string | null;
}

export interface InventoryModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<InventoryAccessContext>;
  audit?: (event: InventoryAuditEvent) => Promise<void>;
  database?: QueryExecutor;
}

class InventoryRequestError extends Error {
  readonly statusCode = 400;
}

class InventoryForbiddenError extends Error {
  readonly statusCode = 403;
}

class InventoryUnavailableError extends Error {
  readonly statusCode = 503;
}

function invalidData(): never {
  throw new InventoryUnavailableError();
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidData();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidData();
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return invalidData();
  return value;
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value, true);
}

function nullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : positiveInteger(value);
}

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
  if (!Number.isSafeInteger(count) || count <= 0 || count > WAREHOUSE_LIMIT) return invalidData();
  return Array.from({ length: count }, () => "?").join(", ");
}

function warehouse(row: DataRow): InventoryWarehouse {
  return {
    id: positiveInteger(row.id),
    code: text(row.code),
    name: text(row.name),
    type: enumeration(row.type, ["factory", "company", "other"]),
    factoryId: nullablePositiveInteger(row.factoryId),
    address: text(row.address, true),
    status: text(row.status),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

function batch(row: DataRow): InventoryBatch {
  return {
    id: positiveInteger(row.id),
    batchNo: text(row.batchNo),
    warehouseId: positiveInteger(row.warehouseId),
    sku: text(row.sku),
    productionDate: nullableText(row.productionDate),
    inboundDate: text(row.inboundDate),
    expiryDate: nullableText(row.expiryDate),
    productionDateEstimated: flag(row.productionDateEstimated),
    expiryDateEstimated: flag(row.expiryDateEstimated),
    availableQuantity: nonNegativeInteger(row.availableQuantity),
    lockedQuantity: nonNegativeInteger(row.lockedQuantity),
    defectiveQuantity: nonNegativeInteger(row.defectiveQuantity),
    pendingInspectionQuantity: nonNegativeInteger(row.pendingInspectionQuantity),
    quarantineQuantity: nonNegativeInteger(row.quarantineQuantity),
    ownership: enumeration(row.ownership, ["company", "factory"]),
    expiryStatus: enumeration(row.expiryStatus, ["normal", "yellow", "red", "expired_frozen"]),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

function reservation(row: DataRow): InventoryReservation {
  return {
    id: positiveInteger(row.id),
    batchId: positiveInteger(row.batchId),
    entityType: enumeration(row.entityType, ["purchase_order", "production_order", "shipment_plan", "historical"]),
    entityId: nullablePositiveInteger(row.entityId),
    requestedQuantity: positiveInteger(row.requestedQuantity),
    reservedQuantity: nonNegativeInteger(row.reservedQuantity),
    shortageQuantity: nonNegativeInteger(row.shortageQuantity),
    priority: integer(row.priority),
    status: enumeration(row.status, ["active"]),
    createdBy: positiveInteger(row.createdBy),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

function transfer(row: DataRow): InventoryTransfer {
  return {
    id: positiveInteger(row.id),
    transferNo: text(row.transferNo),
    fromWarehouseId: positiveInteger(row.fromWarehouseId),
    toWarehouseId: positiveInteger(row.toWarehouseId),
    sku: text(row.sku),
    quantity: positiveInteger(row.quantity),
    reason: text(row.reason, true),
    status: text(row.status),
    requestedBy: positiveInteger(row.requestedBy),
    approvedBy: nullablePositiveInteger(row.approvedBy),
    approvedAt: nullableText(row.approvedAt),
    shippedAt: nullableText(row.shippedAt),
    receivedAt: nullableText(row.receivedAt),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

const WAREHOUSE_COLUMNS = `SELECT
  id, code, name, type, factory_id AS factoryId, address, status,
  created_at AS createdAt, updated_at AS updatedAt
FROM warehouses`;
const BATCH_COLUMNS = `SELECT
  id, batch_no AS batchNo, warehouse_id AS warehouseId, sku,
  production_date AS productionDate, inbound_date AS inboundDate,
  expiry_date AS expiryDate, production_date_estimated AS productionDateEstimated,
  expiry_date_estimated AS expiryDateEstimated, available_quantity AS availableQuantity,
  locked_quantity AS lockedQuantity, defective_quantity AS defectiveQuantity,
  pending_inspection_quantity AS pendingInspectionQuantity,
  quarantine_quantity AS quarantineQuantity, ownership,
  expiry_status AS expiryStatus, created_at AS createdAt, updated_at AS updatedAt
FROM inventory_batches`;
const RESERVATION_COLUMNS = `SELECT
  id, batch_id AS batchId, entity_type AS entityType, entity_id AS entityId,
  requested_quantity AS requestedQuantity, reserved_quantity AS reservedQuantity,
  shortage_quantity AS shortageQuantity, priority, status, created_by AS createdBy,
  created_at AS createdAt, updated_at AS updatedAt
FROM inventory_reservations`;
const TRANSFER_COLUMNS = `SELECT
  id, transfer_no AS transferNo, from_warehouse_id AS fromWarehouseId,
  to_warehouse_id AS toWarehouseId, sku, quantity, reason, status,
  requested_by AS requestedBy, approved_by AS approvedBy, approved_at AS approvedAt,
  shipped_at AS shippedAt, received_at AS receivedAt,
  created_at AS createdAt, updated_at AS updatedAt
FROM inventory_transfers`;

function resolveScope(context: InventoryAccessContext): { factoryId?: number } {
  if (!Array.isArray(context.roles) || !context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new InventoryForbiddenError();
  }
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) return {};
  if (context.roles.includes("factory") && Number.isSafeInteger(context.factoryId) && (context.factoryId ?? 0) > 0) {
    return { factoryId: context.factoryId! };
  }
  throw new InventoryForbiddenError();
}

function parseQuery(query: InventoryQuery): { sensitive: boolean; sku?: string; warehouseId: number } {
  let warehouseId = 0;
  if (query.warehouseId !== undefined) {
    if (typeof query.warehouseId !== "string" || !/^[1-9]\d*$/u.test(query.warehouseId)) {
      throw new InventoryRequestError();
    }
    warehouseId = Number(query.warehouseId);
    if (!Number.isSafeInteger(warehouseId)) throw new InventoryRequestError();
  }
  if (query.sku !== undefined && typeof query.sku !== "string") throw new InventoryRequestError();
  if (query.sensitive !== undefined && typeof query.sensitive !== "string") throw new InventoryRequestError();
  const sku = query.sku?.trim();
  return {
    warehouseId,
    sensitive: query.sensitive === "1",
    ...(sku ? { sku } : {}),
  };
}

async function readInventory(
  database: QueryExecutor,
  scope: { factoryId?: number },
  query: ReturnType<typeof parseQuery>,
): Promise<InventoryResponse> {
  const warehouseRows = scope.factoryId === undefined
    ? await database.query<DataRow>(`${WAREHOUSE_COLUMNS}\nORDER BY id ASC\nLIMIT ${WAREHOUSE_LIMIT + 1}`)
    : await database.query<DataRow>(`${WAREHOUSE_COLUMNS}\nWHERE factory_id = ?\nORDER BY id ASC\nLIMIT ${WAREHOUSE_LIMIT + 1}`, [scope.factoryId]);
  const warehouses = bounded(warehouseRows, WAREHOUSE_LIMIT).map(warehouse);
  const warehouseIds = warehouses.map((row) => row.id);
  if (warehouseIds.length === 0) {
    return { batches: [], warehouses: [], reservations: [], transfers: [] };
  }
  if (query.warehouseId !== 0 && !warehouseIds.includes(query.warehouseId)) {
    throw new InventoryForbiddenError();
  }

  const selectedWarehouseIds = query.warehouseId === 0 ? warehouseIds : [query.warehouseId];
  const batchParams: Array<number | string> = [...selectedWarehouseIds];
  let batchWhere = `warehouse_id IN (${placeholders(selectedWarehouseIds.length)})`;
  if (query.sku !== undefined) {
    batchWhere += " AND sku = ?";
    batchParams.push(query.sku);
  }
  const batchRows = await database.query<DataRow>(
    `${BATCH_COLUMNS}\nWHERE ${batchWhere}\nORDER BY expiry_date ASC, inbound_date DESC, id DESC\nLIMIT ${BATCH_LIMIT}`,
    batchParams,
  );
  const batches = bounded(batchRows, BATCH_LIMIT).map(batch);
  if (batches.some((row) => !selectedWarehouseIds.includes(row.warehouseId))) return invalidData();

  const batchIds = batches.map((row) => row.id);
  const reservationRows = batchIds.length === 0
    ? []
    : await database.query<DataRow>(
        `${RESERVATION_COLUMNS}\nWHERE batch_id IN (${placeholders(batchIds.length)}) AND status = ?\nORDER BY created_at DESC, id DESC\nLIMIT ${RESERVATION_LIMIT}`,
        [...batchIds, "active"],
      );
  const reservations = bounded(reservationRows, RESERVATION_LIMIT).map(reservation);
  if (reservations.some((row) => !batchIds.includes(row.batchId))) return invalidData();

  const warehousePlaceholders = placeholders(warehouseIds.length);
  const transfers = bounded(
    await database.query<DataRow>(
      `${TRANSFER_COLUMNS}\nWHERE from_warehouse_id IN (${warehousePlaceholders}) OR to_warehouse_id IN (${warehousePlaceholders})\nORDER BY created_at DESC, id DESC\nLIMIT ${TRANSFER_LIMIT}`,
      [...warehouseIds, ...warehouseIds],
    ),
    TRANSFER_LIMIT,
  ).map(transfer);
  if (transfers.some((row) => !warehouseIds.includes(row.fromWarehouseId) && !warehouseIds.includes(row.toWarehouseId))) return invalidData();

  return { batches, warehouses, reservations, transfers };
}

export async function registerInventoryModule(app: FastifyInstance, options: InventoryModuleOptions): Promise<void> {
  if (!app.getSchema(inventorySchemaId)) app.addSchema(inventoryResponseSchema);
  app.get<{ Querystring: InventoryQuery; Reply: InventoryResponse }>(
    "/api/v1/inventory",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["inventory"],
        summary: "Read scoped inventory",
        response: {
          200: { $ref: `${inventorySchemaId}#` },
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
      const scope = resolveScope(access);
      if (access.localPreview) return { batches: [], preview: true };
      const query = parseQuery(request.query);
      if (options.database === undefined) throw new InventoryUnavailableError();

      let response: InventoryResponse;
      try {
        response = await readInventory(options.database, scope, query);
      } catch (error) {
        if (error instanceof InventoryForbiddenError || error instanceof InventoryRequestError) throw error;
        throw new InventoryUnavailableError();
      }
      if (query.sensitive) {
        if (options.audit === undefined) throw new InventoryUnavailableError();
        try {
          await options.audit({
            access,
            action: "view",
            module: "inventory",
            entityType: "inventory_batch",
            entityId: query.warehouseId || "all",
            sensitiveView: true,
            requestId: request.id,
            ipAddress: typeof request.headers["cf-connecting-ip"] === "string"
              ? request.headers["cf-connecting-ip"]
              : null,
            deviceId: typeof request.headers["x-topology-device-id"] === "string"
              ? request.headers["x-topology-device-id"]
              : null,
          });
        } catch {
          throw new InventoryUnavailableError();
        }
      }
      return response;
    },
  );
}
