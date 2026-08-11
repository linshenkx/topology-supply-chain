import {
  apiErrorSchemaId,
  purchasePlansResponseSchema,
  purchasePlansSchemaId,
  type PurchasePlan,
  type PurchasePlanFactoryResponse,
  type PurchasePlanItem,
  type PurchasePlanItemCompletionStatus,
  type PurchasePlansResponse,
  type PurchasePlanStatus,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set(["admin", "supply_chain"]);
const FACTORY_ROLE = "factory";
const PLAN_LIMIT = 200;
const ITEM_LIMIT = 2_000;
const LOOKUP_LIMIT = 2_000;

const PLAN_COLUMNS = `SELECT
  id,
  plan_no AS planNo,
  version,
  source,
  source_file_key AS sourceFileKey,
  status,
  confirmation_due_at AS confirmationDueAt,
  confirmed_at AS confirmedAt,
  created_by AS createdBy,
  reviewed_by AS reviewedBy,
  reviewed_at AS reviewedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM purchase_plans`;

const ITEM_COLUMNS = `SELECT
  id,
  purchase_plan_id AS purchasePlanId,
  expected_arrival_date AS expectedArrivalDate,
  factory_id AS factoryId,
  warehouse_id AS warehouseId,
  sku,
  product_name AS productName,
  bom_id AS bomId,
  planned_quantity AS plannedQuantity,
  ordered_quantity AS orderedQuantity,
  over_tolerance_bps AS overToleranceBps,
  under_tolerance_bps AS underToleranceBps,
  completion_status AS completionStatus,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM purchase_plan_items`;

const RESPONSE_COLUMNS = `
    id,
    purchase_plan_id AS purchasePlanId,
    factory_id AS factoryId,
    decision,
    expected_start_date AS expectedStartDate,
    expected_finish_date AS expectedFinishDate,
    proposed_arrival_date AS proposedArrivalDate,
    reason,
    status,
    responded_by AS respondedBy,
    reviewed_by AS reviewedBy,
    reviewed_at AS reviewedAt,
    created_at AS createdAt,
    updated_at AS updatedAt`;

const RESPONSE_OUTPUT_COLUMNS = `
  id,
  purchasePlanId,
  factoryId,
  decision,
  expectedStartDate,
  expectedFinishDate,
  proposedArrivalDate,
  reason,
  status,
  respondedBy,
  reviewedBy,
  reviewedAt,
  createdAt,
  updatedAt`;

type PurchasePlansAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles"
>;
type DataRow = Record<string, unknown>;

export interface PurchasePlansModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<PurchasePlansAccessContext>;
  database?: QueryExecutor;
}

export class PurchasePlansForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Purchase plan access forbidden");
    this.name = "PurchasePlansForbiddenError";
  }
}

export class PurchasePlansUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Purchase plans unavailable");
    this.name = "PurchasePlansUnavailableError";
  }
}

function invalidData(): never {
  throw new PurchasePlansUnavailableError();
}

function integer(
  value: unknown,
  options: { allowZero?: boolean; nullable?: boolean } = {},
): number | null {
  if (value === null && options.nullable === true) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (options.allowZero === true ? 0 : 1)
  ) {
    return invalidData();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed === null) return invalidData();
  return parsed;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = integer(value, { allowZero: true });
  if (parsed === null) return invalidData();
  return parsed;
}

function nullablePositiveInteger(value: unknown): number | null {
  return integer(value, { nullable: true });
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value, true);
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

function placeholders(count: number, maximum: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

function pairPlaceholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > ITEM_LIMIT) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "(?, ?)").join(", ");
}

function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function resolveFactoryScope(
  context: PurchasePlansAccessContext,
): number | null {
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) return null;
  if (context.roles.includes(FACTORY_ROLE)) {
    if (
      context.factoryId === null ||
      !Number.isSafeInteger(context.factoryId) ||
      context.factoryId <= 0
    ) {
      throw new PurchasePlansForbiddenError();
    }
    return context.factoryId;
  }
  throw new PurchasePlansForbiddenError();
}

function plan(row: DataRow): Omit<PurchasePlan, "items" | "responses"> {
  return {
    id: positiveInteger(row.id),
    planNo: string(row.planNo),
    version: positiveInteger(row.version),
    source: string(row.source),
    sourceFileKey: nullableString(row.sourceFileKey),
    status: enumeration<PurchasePlanStatus>(row.status, [
      "draft",
      "pending_approval",
      "awaiting_factory_confirmation",
      "confirmed",
      "disputed",
      "ordering",
      "ordered_complete",
      "superseded",
    ]),
    confirmationDueAt: nullableString(row.confirmationDueAt),
    confirmedAt: nullableString(row.confirmedAt),
    createdBy: positiveInteger(row.createdBy),
    reviewedBy: nullablePositiveInteger(row.reviewedBy),
    reviewedAt: nullableString(row.reviewedAt),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

type ParsedPlanItem = Omit<
  PurchasePlanItem,
  "factoryName" | "warehouseName"
>;

function planItem(row: DataRow): ParsedPlanItem {
  return {
    id: positiveInteger(row.id),
    purchasePlanId: positiveInteger(row.purchasePlanId),
    expectedArrivalDate: string(row.expectedArrivalDate),
    factoryId: positiveInteger(row.factoryId),
    warehouseId: positiveInteger(row.warehouseId),
    sku: string(row.sku),
    productName: string(row.productName),
    bomId: positiveInteger(row.bomId),
    plannedQuantity: positiveInteger(row.plannedQuantity),
    orderedQuantity: nonNegativeInteger(row.orderedQuantity),
    overToleranceBps: nonNegativeInteger(row.overToleranceBps),
    underToleranceBps: nonNegativeInteger(row.underToleranceBps),
    completionStatus: enumeration<PurchasePlanItemCompletionStatus>(
      row.completionStatus,
      [
        "not_ordered",
        "within_tolerance",
        "over_plan_pending",
        "under_plan_pending",
        "exception_approved",
      ],
    ),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function factoryResponse(row: DataRow): PurchasePlanFactoryResponse {
  return {
    id: positiveInteger(row.id),
    purchasePlanId: positiveInteger(row.purchasePlanId),
    factoryId: positiveInteger(row.factoryId),
    decision: enumeration(row.decision, ["confirmed", "unable"]),
    expectedStartDate: string(row.expectedStartDate),
    expectedFinishDate: string(row.expectedFinishDate),
    proposedArrivalDate: nullableString(row.proposedArrivalDate),
    reason: string(row.reason, true),
    status: enumeration(row.status, [
      "accepted",
      "pending_supply_chain",
      "approved",
      "rejected",
    ]),
    respondedBy: positiveInteger(row.respondedBy),
    reviewedBy: nullablePositiveInteger(row.reviewedBy),
    reviewedAt: nullableString(row.reviewedAt),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function uniqueIds(values: readonly number[]): number[] {
  return [...new Set(values)];
}

async function readNames(
  database: QueryExecutor,
  table: "factories" | "warehouses",
  ids: readonly number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await database.query<DataRow>(
    `SELECT id, name
FROM ${table}
WHERE id IN (${placeholders(ids.length, LOOKUP_LIMIT)})
ORDER BY id ASC
LIMIT ${ids.length + 1}`,
    ids,
  );
  ensureBoundedRows(rows, ids.length);
  const names = new Map<number, string>();
  for (const row of rows) {
    const id = positiveInteger(row.id);
    if (!ids.includes(id) || names.has(id)) return invalidData();
    names.set(id, string(row.name));
  }
  return names;
}

async function readLatestResponses(
  database: QueryExecutor,
  pairs: readonly { factoryId: number; planId: number }[],
): Promise<PurchasePlanFactoryResponse[]> {
  if (pairs.length === 0) return [];
  const rows = await database.query<DataRow>(
    `SELECT${RESPONSE_OUTPUT_COLUMNS}
FROM (
  SELECT${RESPONSE_COLUMNS},
    ROW_NUMBER() OVER (
      PARTITION BY purchase_plan_id, factory_id
      ORDER BY created_at DESC, id DESC
    ) AS responseRank
  FROM factory_plan_responses
  WHERE (purchase_plan_id, factory_id) IN (${pairPlaceholders(pairs.length)})
) AS ranked_responses
WHERE responseRank = 1
ORDER BY purchasePlanId ASC, factoryId ASC, id DESC
LIMIT ${pairs.length + 1}`,
    pairs.flatMap(({ planId, factoryId }) => [planId, factoryId]),
  );
  const allowedKeys = new Set(
    pairs.map(({ planId, factoryId }) => `${planId}:${factoryId}`),
  );
  const keys = new Set<string>();
  return ensureBoundedRows(rows, pairs.length).map((row) => {
    const value = factoryResponse(row);
    const key = `${value.purchasePlanId}:${value.factoryId}`;
    if (!allowedKeys.has(key) || keys.has(key)) {
      return invalidData();
    }
    keys.add(key);
    return value;
  });
}

async function readPurchasePlans(
  database: QueryExecutor,
  factoryId: number | null,
): Promise<PurchasePlan[]> {
  const planRows = await database.query<DataRow>(
    `${PLAN_COLUMNS}
ORDER BY created_at DESC, id DESC
LIMIT ${PLAN_LIMIT}`,
  );
  const planIdsSeen = new Set<number>();
  const plans = ensureBoundedRows(planRows, PLAN_LIMIT).map((row) => {
    const value = plan(row);
    if (planIdsSeen.has(value.id)) return invalidData();
    planIdsSeen.add(value.id);
    return value;
  });
  const planIds = plans.map((value) => value.id);
  if (planIds.length === 0) return [];

  const itemRows = await database.query<DataRow>(
    `${ITEM_COLUMNS}
WHERE purchase_plan_id IN (${placeholders(planIds.length, PLAN_LIMIT)})${
      factoryId === null ? "" : "\n  AND factory_id = ?"
    }
ORDER BY purchase_plan_id ASC, id ASC
LIMIT ${ITEM_LIMIT + 1}`,
    factoryId === null ? planIds : [...planIds, factoryId],
  );
  const allowedPlans = new Set(planIds);
  const itemIds = new Set<number>();
  const items = ensureBoundedRows(itemRows, ITEM_LIMIT).map((row) => {
    const value = planItem(row);
    if (
      !allowedPlans.has(value.purchasePlanId) ||
      (factoryId !== null && value.factoryId !== factoryId) ||
      itemIds.has(value.id)
    ) {
      return invalidData();
    }
    itemIds.add(value.id);
    return value;
  });
  if (items.length === 0) return [];

  const factoryIds = uniqueIds(items.map((item) => item.factoryId));
  const warehouseIds = uniqueIds(items.map((item) => item.warehouseId));
  const responsePairKeys = new Set<string>();
  const responsePairs = items.flatMap((item) => {
    const key = `${item.purchasePlanId}:${item.factoryId}`;
    if (responsePairKeys.has(key)) return [];
    responsePairKeys.add(key);
    return [{ planId: item.purchasePlanId, factoryId: item.factoryId }];
  });
  const [factoryNames, warehouseNames, responses] = await Promise.all([
    readNames(database, "factories", factoryIds),
    readNames(database, "warehouses", warehouseIds),
    readLatestResponses(database, responsePairs),
  ]);

  const itemsByPlan = new Map<number, PurchasePlanItem[]>();
  for (const item of items) {
    const enriched: PurchasePlanItem = {
      ...item,
      factoryName:
        factoryNames.get(item.factoryId) ?? `工厂#${item.factoryId}`,
      warehouseName:
        warehouseNames.get(item.warehouseId) ?? `仓库#${item.warehouseId}`,
    };
    itemsByPlan.set(item.purchasePlanId, [
      ...(itemsByPlan.get(item.purchasePlanId) ?? []),
      enriched,
    ]);
  }
  const responseByPair = new Map<string, PurchasePlanFactoryResponse>();
  for (const response of responses) {
    responseByPair.set(
      `${response.purchasePlanId}:${response.factoryId}`,
      response,
    );
  }

  return plans.flatMap((value) => {
    const scopedItems = itemsByPlan.get(value.id) ?? [];
    return scopedItems.length === 0
      ? []
      : [
          {
            ...value,
            items: scopedItems,
            responses: uniqueIds(
              scopedItems.map((item) => item.factoryId),
            ).flatMap((factoryId) => {
              const response = responseByPair.get(`${value.id}:${factoryId}`);
              return response === undefined ? [] : [response];
            }),
          },
        ];
  });
}

export async function registerPurchasePlansModule(
  app: FastifyInstance,
  options: PurchasePlansModuleOptions,
): Promise<void> {
  if (!app.getSchema(purchasePlansSchemaId)) {
    app.addSchema(purchasePlansResponseSchema);
  }

  app.get<{ Reply: PurchasePlansResponse }>(
    "/api/v1/purchase-plans",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["purchase-plans"],
        summary: "Read purchase plans and factory responses",
        response: {
          200: { $ref: `${purchasePlansSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      const factoryId = resolveFactoryScope(access);
      if (access.localPreview) return { plans: [], preview: true };
      if (options.database === undefined) {
        throw new PurchasePlansUnavailableError();
      }

      try {
        return { plans: await readPurchasePlans(options.database, factoryId) };
      } catch {
        throw new PurchasePlansUnavailableError();
      }
    },
  );
}
