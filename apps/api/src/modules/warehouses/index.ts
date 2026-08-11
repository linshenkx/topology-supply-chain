import {
  apiErrorSchemaId,
  warehousesResponseSchema,
  warehousesSchemaId,
  type Warehouse,
  type WarehouseFactory,
  type WarehousesResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain"]);
const WAREHOUSE_LIMIT = 500;
const FACTORY_LIMIT = 500;
const BATCH_LIMIT = 5_000;
const RESERVATION_LIMIT = 5_000;
const TRANSFER_LIMIT = 5_000;
const PLAN_ITEM_LIMIT = 5_000;
const PLAN_LIMIT = 2_000;

type WarehousesAccessContext = Pick<AccessContext, "localPreview" | "roles">;
type DataRow = Record<string, unknown>;
type WarehouseBase = Omit<Warehouse, "blockers" | "mergedIntoWarehouseId" | "status"> & { rawStatus: string };
type BatchSummary = { id: number; warehouseId: number; quantity: number };
type ReservationSummary = { batchId: number; reservedQuantity: number };
type TransferSummary = { fromWarehouseId: number; toWarehouseId: number; status: string };
type PlanItemSummary = { purchasePlanId: number; warehouseId: number };
type PlanSummary = { id: number; status: string };

export interface WarehousesModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<WarehousesAccessContext>;
  database?: QueryExecutor;
}

class WarehousesForbiddenError extends Error { readonly statusCode = 403; }
class WarehousesUnavailableError extends Error { readonly statusCode = 503; }
function invalidData(): never { throw new WarehousesUnavailableError(); }
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
function nullablePositiveInteger(value: unknown): number | null { return value === null ? null : positiveInteger(value); }
function enumeration<const Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) return invalidData();
  return value as Value;
}
function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) return invalidData();
  return total;
}
function bounded<Row>(rows: readonly Row[], maximum: number): readonly Row[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function warehouseBase(row: DataRow): WarehouseBase {
  return {
    id: positiveInteger(row.id), code: text(row.code), name: text(row.name),
    type: enumeration(row.type, ["factory", "company", "other"]),
    factoryId: nullablePositiveInteger(row.factoryId), address: text(row.address, true),
    rawStatus: text(row.status), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function factory(row: DataRow): WarehouseFactory {
  return {
    id: positiveInteger(row.id), name: text(row.name), code: text(row.code), status: text(row.status),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function batch(row: DataRow): BatchSummary {
  const quantities = [row.availableQuantity, row.lockedQuantity, row.defectiveQuantity, row.pendingInspectionQuantity, row.quarantineQuantity].map(nonNegativeInteger);
  return { id: positiveInteger(row.id), warehouseId: positiveInteger(row.warehouseId), quantity: quantities.reduce(safeAdd, 0) };
}
function reservation(row: DataRow): ReservationSummary {
  if (row.status !== "active") return invalidData();
  return { batchId: positiveInteger(row.batchId), reservedQuantity: nonNegativeInteger(row.reservedQuantity) };
}
function transfer(row: DataRow): TransferSummary {
  return { fromWarehouseId: positiveInteger(row.fromWarehouseId), toWarehouseId: positiveInteger(row.toWarehouseId), status: text(row.status) };
}
function planItem(row: DataRow): PlanItemSummary {
  return { purchasePlanId: positiveInteger(row.purchasePlanId), warehouseId: positiveInteger(row.warehouseId) };
}
function plan(row: DataRow): PlanSummary { return { id: positiveInteger(row.id), status: text(row.status) }; }

const WAREHOUSE_COLUMNS = `SELECT id, code, name, type, factory_id AS factoryId, address, status,
  created_at AS createdAt, updated_at AS updatedAt FROM warehouses`;
const FACTORY_COLUMNS = `SELECT id, name, code, status, created_at AS createdAt,
  updated_at AS updatedAt FROM factories`;
const BATCH_COLUMNS = `SELECT id, warehouse_id AS warehouseId,
  available_quantity AS availableQuantity, locked_quantity AS lockedQuantity,
  defective_quantity AS defectiveQuantity, pending_inspection_quantity AS pendingInspectionQuantity,
  quarantine_quantity AS quarantineQuantity FROM inventory_batches`;
const RESERVATION_COLUMNS = `SELECT batch_id AS batchId, reserved_quantity AS reservedQuantity,
  status FROM inventory_reservations`;
const TRANSFER_COLUMNS = `SELECT from_warehouse_id AS fromWarehouseId,
  to_warehouse_id AS toWarehouseId, status FROM inventory_transfers`;
const PLAN_ITEM_COLUMNS = `SELECT purchase_plan_id AS purchasePlanId,
  warehouse_id AS warehouseId FROM purchase_plan_items`;
const PLAN_COLUMNS = `SELECT id, status FROM purchase_plans`;

function requireRole(context: WarehousesAccessContext): void {
  if (!Array.isArray(context.roles) || !context.roles.some((role) => ALLOWED_ROLES.has(role))) throw new WarehousesForbiddenError();
}

function normalizeStatus(rawStatus: string): { mergedIntoWarehouseId: number | null; status: Warehouse["status"] } {
  if (rawStatus === "active" || rawStatus === "inactive") return { status: rawStatus, mergedIntoWarehouseId: null };
  if (!rawStatus.startsWith("merged:")) return invalidData();
  const target = Number(rawStatus.slice(7));
  if (!Number.isSafeInteger(target) || target <= 0) return invalidData();
  return { status: "merged", mergedIntoWarehouseId: target };
}

async function readWarehouses(database: QueryExecutor): Promise<WarehousesResponse> {
  const [warehouseRows, factoryRows, batchRows, reservationRows, transferRows, planItemRows, planRows] = await Promise.all([
    database.query<DataRow>(`${WAREHOUSE_COLUMNS}\nORDER BY updated_at DESC, id DESC\nLIMIT ${WAREHOUSE_LIMIT}`),
    database.query<DataRow>(`${FACTORY_COLUMNS}\nORDER BY id ASC\nLIMIT ${FACTORY_LIMIT}`),
    database.query<DataRow>(`${BATCH_COLUMNS}\nORDER BY id ASC\nLIMIT ${BATCH_LIMIT}`),
    database.query<DataRow>(`${RESERVATION_COLUMNS}\nWHERE status = ?\nORDER BY created_at DESC, id DESC\nLIMIT ${RESERVATION_LIMIT}`, ["active"]),
    database.query<DataRow>(`${TRANSFER_COLUMNS}\nORDER BY created_at DESC, id DESC\nLIMIT ${TRANSFER_LIMIT}`),
    database.query<DataRow>(`${PLAN_ITEM_COLUMNS}\nORDER BY id ASC\nLIMIT ${PLAN_ITEM_LIMIT}`),
    database.query<DataRow>(`${PLAN_COLUMNS}\nORDER BY updated_at DESC, id DESC\nLIMIT ${PLAN_LIMIT}`),
  ]);
  const bases = bounded(warehouseRows, WAREHOUSE_LIMIT).map(warehouseBase);
  const factories = bounded(factoryRows, FACTORY_LIMIT).map(factory);
  const batches = bounded(batchRows, BATCH_LIMIT).map(batch);
  const reservations = bounded(reservationRows, RESERVATION_LIMIT).map(reservation);
  const transfers = bounded(transferRows, TRANSFER_LIMIT).map(transfer);
  const planItems = bounded(planItemRows, PLAN_ITEM_LIMIT).map(planItem);
  const plans = bounded(planRows, PLAN_LIMIT).map(plan);
  const batchWarehouse = new Map(batches.map((row) => [row.id, row.warehouseId]));
  const openPlans = new Set(plans.filter((row) => !["ordered_complete", "superseded"].includes(row.status)).map((row) => row.id));

  return {
    factories,
    warehouses: bases.map((row) => {
      const normalized = normalizeStatus(row.rawStatus);
      let inventory = 0;
      let reserved = 0;
      let transferCount = 0;
      let unfinishedBusiness = 0;
      for (const value of batches) if (value.warehouseId === row.id) inventory = safeAdd(inventory, value.quantity);
      for (const value of reservations) if (batchWarehouse.get(value.batchId) === row.id) reserved = safeAdd(reserved, value.reservedQuantity);
      for (const value of transfers) if (!["received", "rejected"].includes(value.status) && (value.fromWarehouseId === row.id || value.toWarehouseId === row.id)) transferCount = safeAdd(transferCount, 1);
      for (const value of planItems) if (value.warehouseId === row.id && openPlans.has(value.purchasePlanId)) unfinishedBusiness = safeAdd(unfinishedBusiness, 1);
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        factoryId: row.factoryId,
        address: row.address,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...normalized,
        blockers: { inventory, reservations: reserved, transfers: transferCount, unfinishedBusiness },
      };
    }),
  };
}

export async function registerWarehousesModule(app: FastifyInstance, options: WarehousesModuleOptions): Promise<void> {
  if (!app.getSchema(warehousesSchemaId)) app.addSchema(warehousesResponseSchema);
  app.get<{ Reply: WarehousesResponse }>(
    "/api/v1/warehouses",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store"); reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie"); done();
      },
      schema: {
        tags: ["warehouses"], summary: "Read warehouse master data and blockers",
        response: {
          200: { $ref: `${warehousesSchemaId}#` }, 401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      requireRole(access);
      if (access.localPreview) return { warehouses: [], factories: [], preview: true };
      if (options.database === undefined) throw new WarehousesUnavailableError();
      try { return await readWarehouses(options.database); }
      catch (error) {
        if (error instanceof WarehousesForbiddenError) throw error;
        throw new WarehousesUnavailableError();
      }
    },
  );
}
