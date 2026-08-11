import {
  apiErrorSchemaId,
  stocktakesResponseSchema,
  stocktakesSchemaId,
  type Stocktake,
  type StocktakeCount,
  type StocktakeFactory,
  type StocktakesResponse,
  type StocktakeTarget,
  type StocktakeWarehouse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain", "factory"]);
const INTERNAL_ROLES = new Set(["supply_chain", "finance", "admin", "company_qc"]);
const WAREHOUSE_LIMIT = 500;
const FACTORY_LIMIT = 500;
const STOCKTAKE_LIMIT = 100;
const TARGET_LIMIT = 5_000;
const COUNT_LIMIT = 10_000;

type StocktakesAccessContext = Pick<AccessContext, "factoryId" | "localPreview" | "roles">;
type DataRow = Record<string, unknown>;

export interface StocktakesModuleOptions {
  authenticate: (request: FastifyRequest) => Promise<StocktakesAccessContext>;
  database?: QueryExecutor;
}

class StocktakesForbiddenError extends Error {
  readonly statusCode = 403;
}

class StocktakesUnavailableError extends Error {
  readonly statusCode = 503;
}

function invalidData(): never { throw new StocktakesUnavailableError(); }
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
function enumeration<const Value extends string>(value: unknown, values: readonly Value[]): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) return invalidData();
  return value as Value;
}
function bounded<Row>(rows: readonly Row[], maximum: number): readonly Row[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}
function placeholders(count: number, maximum: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) return invalidData();
  return Array.from({ length: count }, () => "?").join(", ");
}

function warehouse(row: DataRow): StocktakeWarehouse {
  return {
    id: positiveInteger(row.id), code: text(row.code), name: text(row.name),
    type: enumeration(row.type, ["factory", "company", "other"]),
    factoryId: nullablePositiveInteger(row.factoryId), address: text(row.address, true),
    status: text(row.status), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function factory(row: DataRow): StocktakeFactory {
  return {
    id: positiveInteger(row.id), name: text(row.name), code: text(row.code),
    status: text(row.status), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}
function count(row: DataRow): StocktakeCount {
  return {
    id: positiveInteger(row.id), stocktakeId: positiveInteger(row.stocktakeId),
    batchId: nullablePositiveInteger(row.batchId), sku: text(row.sku),
    countRound: countRound(row.countRound),
    availableQuantity: nonNegativeInteger(row.availableQuantity),
    lockedQuantity: nonNegativeInteger(row.lockedQuantity),
    defectiveQuantity: nonNegativeInteger(row.defectiveQuantity),
    pendingInspectionQuantity: nonNegativeInteger(row.pendingInspectionQuantity),
    totalQuantity: nonNegativeInteger(row.totalQuantity), countedBy: positiveInteger(row.countedBy),
    countedAt: text(row.countedAt),
  };
}
function countRound(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value;
  return invalidData();
}
function stocktakeBase(row: DataRow): Omit<Stocktake, "targets" | "counts"> {
  return {
    id: positiveInteger(row.id), stocktakeNo: text(row.stocktakeNo),
    warehouseId: positiveInteger(row.warehouseId),
    scope: enumeration(row.scope, ["full_warehouse", "sku_sample", "batch"]),
    dueDate: text(row.dueDate),
    status: enumeration(row.status, ["draft", "frozen", "first_count", "recount", "pending_approval", "completed"]),
    frozenAt: nullableText(row.frozenAt), createdBy: positiveInteger(row.createdBy),
    assignedFactoryId: nullablePositiveInteger(row.assignedFactoryId),
    createdAt: text(row.createdAt), updatedAt: text(row.updatedAt),
  };
}

const WAREHOUSE_COLUMNS = `SELECT id, code, name, type, factory_id AS factoryId, address, status,
  created_at AS createdAt, updated_at AS updatedAt FROM warehouses`;
const FACTORY_COLUMNS = `SELECT id, name, code, status, created_at AS createdAt,
  updated_at AS updatedAt FROM factories`;
const STOCKTAKE_COLUMNS = `SELECT id, stocktake_no AS stocktakeNo, warehouse_id AS warehouseId,
  scope, due_date AS dueDate, status, frozen_at AS frozenAt, created_by AS createdBy,
  assigned_factory_id AS assignedFactoryId, created_at AS createdAt, updated_at AS updatedAt
FROM stocktakes`;
const COUNT_COLUMNS = `SELECT id, stocktake_id AS stocktakeId, batch_id AS batchId, sku,
  count_round AS countRound, available_quantity AS availableQuantity,
  locked_quantity AS lockedQuantity, defective_quantity AS defectiveQuantity,
  pending_inspection_quantity AS pendingInspectionQuantity, total_quantity AS totalQuantity,
  counted_by AS countedBy, counted_at AS countedAt
FROM stocktake_counts`;

function resolveScope(context: StocktakesAccessContext): { canCreate: boolean; factoryId?: number } {
  if (!Array.isArray(context.roles) || !context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new StocktakesForbiddenError();
  }
  const internal = context.roles.some((role) => INTERNAL_ROLES.has(role));
  if (internal) return { canCreate: true };
  if (context.roles.includes("factory") && Number.isSafeInteger(context.factoryId) && (context.factoryId ?? 0) > 0) {
    return { canCreate: false, factoryId: context.factoryId! };
  }
  throw new StocktakesForbiddenError();
}

async function enrichStocktake(database: QueryExecutor, task: Omit<Stocktake, "targets" | "counts">): Promise<Stocktake> {
  const targetRows = bounded(await database.query<DataRow>(
    `SELECT batch_id AS batchId, sku FROM stocktake_counts
WHERE stocktake_id = ? AND count_round = ?
ORDER BY sku ASC, batch_id ASC, id ASC
LIMIT ${TARGET_LIMIT + 1}`,
    [task.id, 0],
  ), TARGET_LIMIT);
  const targetsWithoutBatchNo = targetRows.map((row) => ({
    batchId: nullablePositiveInteger(row.batchId), sku: text(row.sku),
  }));
  const countRows = bounded(await database.query<DataRow>(
    `${COUNT_COLUMNS}
WHERE stocktake_id = ? AND count_round IN (?, ?)
ORDER BY count_round ASC, sku ASC, batch_id ASC, id ASC
LIMIT ${COUNT_LIMIT + 1}`,
    [task.id, 1, 2],
  ), COUNT_LIMIT);
  const counts = countRows.map(count);
  if (counts.some((row) => row.stocktakeId !== task.id)) return invalidData();

  const batchIds = Array.from(new Set(targetsWithoutBatchNo.flatMap((row) => row.batchId === null ? [] : [row.batchId])));
  const batchRows = batchIds.length === 0 ? [] : bounded(await database.query<DataRow>(
    `SELECT id, batch_no AS batchNo FROM inventory_batches
WHERE id IN (${placeholders(batchIds.length, TARGET_LIMIT)})
ORDER BY id ASC
LIMIT ${TARGET_LIMIT + 1}`,
    batchIds,
  ), TARGET_LIMIT);
  const batchNos = new Map(batchRows.map((row) => [positiveInteger(row.id), text(row.batchNo)]));
  if (batchNos.size !== batchIds.length || batchIds.some((id) => !batchNos.has(id))) return invalidData();
  const targets: StocktakeTarget[] = targetsWithoutBatchNo.map((row) => ({
    ...row, batchNo: row.batchId === null ? null : (batchNos.get(row.batchId) ?? invalidData()),
  }));
  return { ...task, targets, counts };
}

async function readStocktakes(database: QueryExecutor, scope: ReturnType<typeof resolveScope>): Promise<StocktakesResponse> {
  const warehouseRows = scope.factoryId === undefined
    ? await database.query<DataRow>(`${WAREHOUSE_COLUMNS}\nORDER BY id ASC\nLIMIT ${WAREHOUSE_LIMIT + 1}`)
    : await database.query<DataRow>(`${WAREHOUSE_COLUMNS}\nWHERE factory_id = ?\nORDER BY id ASC\nLIMIT ${WAREHOUSE_LIMIT + 1}`, [scope.factoryId]);
  const warehouses = bounded(warehouseRows, WAREHOUSE_LIMIT).map(warehouse);
  const warehouseIds = warehouses.map((row) => row.id);
  if (warehouseIds.length === 0) return { stocktakes: [], warehouses: [], factories: [], canCreate: scope.canCreate };

  const taskRows = await database.query<DataRow>(
    `${STOCKTAKE_COLUMNS}
WHERE warehouse_id IN (${placeholders(warehouseIds.length, WAREHOUSE_LIMIT)})
ORDER BY created_at DESC, id DESC
LIMIT ${STOCKTAKE_LIMIT}`,
    warehouseIds,
  );
  const bases = bounded(taskRows, STOCKTAKE_LIMIT).map(stocktakeBase);
  if (bases.some((row) => !warehouseIds.includes(row.warehouseId))) return invalidData();
  const stocktakes: Stocktake[] = [];
  for (const task of bases) stocktakes.push(await enrichStocktake(database, task));

  const factories = scope.canCreate
    ? bounded(await database.query<DataRow>(`${FACTORY_COLUMNS}\nORDER BY id ASC\nLIMIT ${FACTORY_LIMIT + 1}`), FACTORY_LIMIT).map(factory)
    : [];
  return { stocktakes, warehouses, factories, canCreate: scope.canCreate };
}

export async function registerStocktakesModule(app: FastifyInstance, options: StocktakesModuleOptions): Promise<void> {
  if (!app.getSchema(stocktakesSchemaId)) app.addSchema(stocktakesResponseSchema);
  app.get<{ Reply: StocktakesResponse }>(
    "/api/v1/stocktakes",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["stocktakes"], summary: "Read scoped stocktakes",
        response: {
          200: { $ref: `${stocktakesSchemaId}#` }, 401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      const scope = resolveScope(access);
      if (access.localPreview) return { stocktakes: [], warehouses: [], factories: [], canCreate: true, preview: true };
      if (options.database === undefined) throw new StocktakesUnavailableError();
      try {
        return await readStocktakes(options.database, scope);
      } catch (error) {
        if (error instanceof StocktakesForbiddenError) throw error;
        throw new StocktakesUnavailableError();
      }
    },
  );
}
