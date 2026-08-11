import {
  apiErrorSchemaId,
  supplierPerformanceResponseSchema,
  supplierPerformanceSchemaId,
  supplierPricesResponseSchema,
  supplierPricesSchemaId,
  supplierSkusResponseSchema,
  supplierSkusSchemaId,
  suppliersResponseSchema,
  suppliersSchemaId,
  type SupplierCapacityRisk,
  type SupplierFactory,
  type SupplierMetricKey,
  type SupplierPerformanceComment,
  type SupplierPerformanceRanking,
  type SupplierPerformanceResponse,
  type SupplierPerformanceWeights,
  type SupplierPriceAgreement,
  type SupplierPriceChangeRequest,
  type SupplierPricesResponse,
  type SupplierProfile,
  type SupplierReviewType,
  type SupplierSkuCatalogItem,
  type SupplierSkuRelation,
  type SupplierSkusResponse,
  type SupplierSummary,
  type SuppliersResponse,
} from "@topology/contracts";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "company_qc",
]);
const PERFORMANCE_CONFIGURATION_ROLES = new Set(["admin", "supply_chain"]);
const PERFORMANCE_REVIEW_ROLES = new Set([
  "admin",
  "supply_chain",
  "company_qc",
]);

const SUPPLIER_LIMIT = 500;
const SUPPLIER_PROFILE_LIMIT = 200;
const FACTORY_LIMIT = 200;
const RELATION_LIMIT = 500;
const PRICE_RELATION_LIMIT = 2_000;
const SKU_LIMIT = 1_000;
const AGREEMENT_LIMIT = 2_000;
const PRICE_REQUEST_LIMIT = 500;
const ORDER_ITEM_LIMIT = 5_000;
const RISK_LIMIT = 10_000;
const REVIEW_LIMIT = 5_000;
const WEIGHT_LIMIT = 100;
const DELIVERY_LIMIT = 20_000;

const QUARTER_PATTERN = /^\d{4}-Q[1-4]$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const METRIC_KEYS: readonly SupplierMetricKey[] = [
  "delivery",
  "quality",
  "exception",
  "preparation",
  "satisfaction",
  "sampling",
];
const DEFAULT_WEIGHTS: Readonly<Record<number, SupplierPerformanceWeights>> = {
  1: {
    delivery: 2_500,
    quality: 2_000,
    exception: 1_500,
    preparation: 1_000,
    satisfaction: 1_500,
    sampling: 1_500,
  },
  2: {
    delivery: 3_000,
    quality: 2_500,
    exception: 1_500,
    preparation: 1_500,
    satisfaction: 0,
    sampling: 1_500,
  },
  3: {
    delivery: 3_000,
    quality: 2_500,
    exception: 2_000,
    preparation: 1_000,
    satisfaction: 0,
    sampling: 1_500,
  },
};

const SUPPLIER_PROFILE_COLUMNS = `SELECT
  id,
  code,
  name,
  tier,
  managed_by_factory_id AS managedByFactoryId,
  unified_social_credit_code AS unifiedSocialCreditCode,
  address,
  contact_name AS contactName,
  contact_phone AS contactPhone,
  business_scope AS businessScope,
  verification_status AS verificationStatus,
  status
FROM suppliers`;

const SUPPLIER_SUMMARY_COLUMNS = `SELECT
  id,
  code,
  name,
  tier,
  managed_by_factory_id AS managedByFactoryId,
  status
FROM suppliers`;

const FACTORY_COLUMNS = `SELECT
  id,
  code,
  name,
  status
FROM factories`;

const RELATION_COLUMNS = `SELECT
  id,
  factory_id AS factoryId,
  supplier_id AS supplierId,
  sku,
  is_primary AS isPrimary,
  priority,
  minimum_order_quantity AS minimumOrderQuantity,
  packaging_multiple AS packagingMultiple,
  purchase_unit AS purchaseUnit,
  lead_time_days AS leadTimeDays,
  daily_capacity AS dailyCapacity,
  monthly_capacity AS monthlyCapacity,
  effective_from AS effectiveFrom,
  status
FROM supplier_skus`;

const SKU_COLUMNS = `SELECT
  id,
  code,
  name,
  item_type AS itemType,
  stock_unit AS stockUnit
FROM skus`;

type SupplierAccessContext = Pick<
  AccessContext,
  | "email"
  | "factoryId"
  | "localPreview"
  | "name"
  | "roles"
  | "supplierId"
  | "userId"
>;
type DataRow = Record<string, unknown>;
type DataScope =
  | { kind: "factory"; factoryId: number }
  | { kind: "factory_supplier"; factoryId: number; supplierId: number }
  | { kind: "internal" }
  | { kind: "supplier"; supplierId: number };

export interface SupplierAuditEvent {
  action: "export_supplier_performance" | "view";
  module: "supplier_performance" | "supplier_prices";
  entityType: "price_list" | "supplier_ranking";
  entityId: string;
  exported?: true;
  sensitiveView: true;
  count?: number;
}

export interface SupplierAuditActor {
  email: string;
  factoryId: number | null;
  name: string;
  roles: readonly string[];
  supplierId: number | null;
  userId: number;
}

export type SupplierAuditPort = (
  event: SupplierAuditEvent,
  actor: SupplierAuditActor,
  request: FastifyRequest,
) => Promise<void>;

export interface SupplierPerformanceExportInput {
  quarter: string;
  rankings: readonly SupplierPerformanceRanking[];
  watermark: string;
}

export type SupplierPerformanceExportPort = (
  input: SupplierPerformanceExportInput,
) => Promise<Uint8Array>;

export interface SuppliersModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<SupplierAccessContext>;
  audit?: SupplierAuditPort;
  database?: QueryExecutor;
  exportPerformance?: SupplierPerformanceExportPort;
  now?: () => Date;
}

export class SuppliersBadRequestError extends Error {
  readonly statusCode = 400;

  constructor() {
    super("Invalid supplier request");
    this.name = "SuppliersBadRequestError";
  }
}

export class SuppliersForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Supplier access forbidden");
    this.name = "SuppliersForbiddenError";
  }
}

export class SuppliersUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Supplier data unavailable");
    this.name = "SuppliersUnavailableError";
  }
}

function invalidData(): never {
  throw new SuppliersUnavailableError();
}

function badRequest(): never {
  throw new SuppliersBadRequestError();
}

function integer(
  value: unknown,
  options: { allowZero?: boolean; maximum?: number } = {},
): number {
  const minimum = options.allowZero === true ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    return invalidData();
  }
  return value;
}

function nullableInteger(
  value: unknown,
  options: { allowZero?: boolean } = {},
): number | null {
  if (value === null) return null;
  return integer(value, options);
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

function day(value: unknown): string {
  const result = string(value);
  if (!DAY_PATTERN.test(result)) return invalidData();
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  ) {
    return invalidData();
  }
  return result;
}

function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function placeholders(count: number, maximum: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

function uniqueIntegers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function isInternal(context: SupplierAccessContext): boolean {
  return context.roles.some((role) => INTERNAL_ROLES.has(role));
}

function auditActor(context: SupplierAccessContext): SupplierAuditActor {
  return {
    email: context.email,
    factoryId: context.factoryId,
    name: context.name,
    roles: [...context.roles],
    supplierId: context.supplierId,
    userId: context.userId,
  };
}

function boundOrganizationId(value: number | null): number {
  if (!isPositiveSafeInteger(value)) throw new SuppliersForbiddenError();
  return value;
}

function dataScope(context: SupplierAccessContext): DataScope {
  if (isInternal(context)) return { kind: "internal" };

  const hasFactoryRole = context.roles.includes("factory");
  const hasSupplierRole = context.roles.includes("supplier_qc");
  if (!hasFactoryRole && !hasSupplierRole) {
    throw new SuppliersForbiddenError();
  }

  const factoryId = hasFactoryRole
    ? boundOrganizationId(context.factoryId)
    : undefined;
  const supplierId = hasSupplierRole
    ? boundOrganizationId(context.supplierId)
    : undefined;
  if (factoryId !== undefined && supplierId !== undefined) {
    return { kind: "factory_supplier", factoryId, supplierId };
  }
  if (factoryId !== undefined) return { kind: "factory", factoryId };
  if (supplierId !== undefined) return { kind: "supplier", supplierId };
  throw new SuppliersForbiddenError();
}

function requireDatabase(options: SuppliersModuleOptions): QueryExecutor {
  if (options.database === undefined) throw new SuppliersUnavailableError();
  return options.database;
}

function supplierProfile(row: DataRow): SupplierProfile {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    tier: nullableInteger(row.tier),
    managedByFactoryId: nullableInteger(row.managedByFactoryId),
    unifiedSocialCreditCode: string(row.unifiedSocialCreditCode, true),
    address: string(row.address, true),
    contactName: string(row.contactName, true),
    contactPhone: string(row.contactPhone, true),
    businessScope: string(row.businessScope, true),
    verificationStatus: enumeration(row.verificationStatus, [
      "pending",
      "approved",
      "rejected",
    ]),
    status: string(row.status),
  };
}

function supplierSummary(row: DataRow): SupplierSummary {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    tier: nullableInteger(row.tier),
    managedByFactoryId: nullableInteger(row.managedByFactoryId),
    status: string(row.status),
  };
}

function factory(row: DataRow): SupplierFactory {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    status: string(row.status),
  };
}

function sku(row: DataRow): SupplierSkuCatalogItem {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    itemType:
      row.itemType === null
        ? null
        : enumeration(row.itemType, [
            "finished",
            "auxiliary",
            "component",
          ]),
    stockUnit: nullableString(row.stockUnit),
  };
}

function relation(row: DataRow): SupplierSkuRelation {
  return {
    id: integer(row.id),
    factoryId: integer(row.factoryId),
    supplierId: integer(row.supplierId),
    sku: string(row.sku),
    isPrimary: boolean(row.isPrimary),
    priority: integer(row.priority),
    minimumOrderQuantity: integer(row.minimumOrderQuantity),
    packagingMultiple: integer(row.packagingMultiple),
    purchaseUnit: string(row.purchaseUnit, true),
    leadTimeDays: nullableInteger(row.leadTimeDays, { allowZero: true }),
    dailyCapacity: nullableInteger(row.dailyCapacity),
    monthlyCapacity: nullableInteger(row.monthlyCapacity),
    effectiveFrom: day(row.effectiveFrom),
    status: enumeration(row.status, ["pending", "active", "inactive"]),
  };
}

function agreement(row: DataRow): SupplierPriceAgreement {
  const effectiveFrom = day(row.effectiveFrom);
  const effectiveTo = row.effectiveTo === null ? null : day(row.effectiveTo);
  if (effectiveTo !== null && effectiveTo < effectiveFrom) return invalidData();
  return {
    id: integer(row.id),
    supplierId: integer(row.supplierId),
    sku: string(row.sku),
    currency: string(row.currency),
    unitPriceTaxIncludedMinor: integer(row.unitPriceTaxIncludedMinor, {
      allowZero: true,
    }),
    unitPriceTaxExcludedMinor: integer(row.unitPriceTaxExcludedMinor, {
      allowZero: true,
    }),
    taxRateBps: integer(row.taxRateBps, {
      allowZero: true,
      maximum: 10_000,
    }),
    effectiveFrom,
    effectiveTo,
    status: string(row.status),
  };
}

function priceRequest(row: DataRow): SupplierPriceChangeRequest {
  return {
    id: integer(row.id),
    currentAgreementId: nullableInteger(row.currentAgreementId),
    supplierId: integer(row.supplierId),
    sku: string(row.sku),
    proposedTaxIncludedMinor: integer(row.proposedTaxIncludedMinor, {
      allowZero: true,
    }),
    proposedTaxExcludedMinor: integer(row.proposedTaxExcludedMinor, {
      allowZero: true,
    }),
    proposedTaxRateBps: integer(row.proposedTaxRateBps, {
      allowZero: true,
      maximum: 10_000,
    }),
    proposedEffectiveFrom: day(row.proposedEffectiveFrom),
    reason: string(row.reason, true),
    decision: enumeration(row.decision, ["pending", "approved", "rejected"]),
  };
}

async function readSuppliers(
  database: QueryExecutor,
  scope: DataScope,
): Promise<SuppliersResponse> {
  let supplierQuery: Promise<readonly DataRow[]>;
  let factoryQuery: Promise<readonly DataRow[]>;
  if (scope.kind === "internal") {
    supplierQuery = database.query<DataRow>(
      `${SUPPLIER_PROFILE_COLUMNS}
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_PROFILE_LIMIT}`,
    );
    factoryQuery = database.query<DataRow>(
      `${FACTORY_COLUMNS}
ORDER BY updated_at DESC, id DESC
LIMIT ${FACTORY_LIMIT}`,
    );
  } else if (scope.kind === "factory") {
    supplierQuery = database.query<DataRow>(
      `${SUPPLIER_PROFILE_COLUMNS}
WHERE managed_by_factory_id = ?
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_PROFILE_LIMIT}`,
      [scope.factoryId],
    );
    factoryQuery = database.query<DataRow>(
      `${FACTORY_COLUMNS}
WHERE id = ?
ORDER BY id DESC
LIMIT 1`,
      [scope.factoryId],
    );
  } else if (scope.kind === "supplier") {
    supplierQuery = database.query<DataRow>(
      `${SUPPLIER_PROFILE_COLUMNS}
WHERE id = ? AND status = ?
ORDER BY id DESC
LIMIT 1`,
      [scope.supplierId, "active"],
    );
    factoryQuery = Promise.resolve([]);
  } else {
    supplierQuery = database.query<DataRow>(
      `${SUPPLIER_PROFILE_COLUMNS}
WHERE managed_by_factory_id = ? OR (id = ? AND status = ?)
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_PROFILE_LIMIT}`,
      [scope.factoryId, scope.supplierId, "active"],
    );
    factoryQuery = database.query<DataRow>(
      `${FACTORY_COLUMNS}
WHERE id = ?
ORDER BY id DESC
LIMIT 1`,
      [scope.factoryId],
    );
  }

  const [supplierRows, factoryRows] = await Promise.all([
    supplierQuery,
    factoryQuery,
  ]);
  return {
    suppliers: ensureBoundedRows(
      supplierRows,
      SUPPLIER_PROFILE_LIMIT,
    ).map(supplierProfile),
    factories: ensureBoundedRows(factoryRows, FACTORY_LIMIT).map(factory),
  };
}

async function readRelations(
  database: QueryExecutor,
  scope: DataScope,
  options: { activeOnly: boolean; limit: number },
): Promise<SupplierSkuRelation[]> {
  const statusClause = options.activeOnly ? "status = ?" : "";
  const statusParams = options.activeOnly ? ["active"] : [];
  let where = statusClause;
  let params: readonly (number | string)[] = statusParams;

  if (scope.kind === "factory") {
    where = ["factory_id = ?", statusClause].filter(Boolean).join(" AND ");
    params = [scope.factoryId, ...statusParams];
  } else if (scope.kind === "supplier") {
    where = ["supplier_id = ?", statusClause].filter(Boolean).join(" AND ");
    params = [scope.supplierId, ...statusParams];
  } else if (scope.kind === "factory_supplier") {
    where = [`(factory_id = ? OR supplier_id = ?)`, statusClause]
      .filter(Boolean)
      .join(" AND ");
    params = [scope.factoryId, scope.supplierId, ...statusParams];
  }

  const rows = await database.query<DataRow>(
    `${RELATION_COLUMNS}${where.length > 0 ? `\nWHERE ${where}` : ""}
ORDER BY id DESC
LIMIT ${options.limit}`,
    params,
  );
  return ensureBoundedRows(rows, options.limit).map(relation);
}

async function readSupplierSummariesByIds(
  database: QueryExecutor,
  ids: readonly number[],
): Promise<SupplierSummary[]> {
  if (ids.length === 0) return [];
  const rows = await database.query<DataRow>(
    `${SUPPLIER_SUMMARY_COLUMNS}
WHERE id IN (${placeholders(ids.length, SUPPLIER_LIMIT)})
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
    ids,
  );
  return ensureBoundedRows(rows, SUPPLIER_LIMIT).map(supplierSummary);
}

async function readFactoriesByIds(
  database: QueryExecutor,
  ids: readonly number[],
): Promise<SupplierFactory[]> {
  if (ids.length === 0) return [];
  const rows = await database.query<DataRow>(
    `${FACTORY_COLUMNS}
WHERE id IN (${placeholders(ids.length, FACTORY_LIMIT)})
ORDER BY updated_at DESC, id DESC
LIMIT ${FACTORY_LIMIT}`,
    ids,
  );
  return ensureBoundedRows(rows, FACTORY_LIMIT).map(factory);
}

async function readSkusByCodes(
  database: QueryExecutor,
  codes: readonly string[],
): Promise<SupplierSkuCatalogItem[]> {
  if (codes.length === 0) return [];
  const rows = await database.query<DataRow>(
    `${SKU_COLUMNS}
WHERE status = ? AND code IN (${placeholders(codes.length, SKU_LIMIT)})
ORDER BY updated_at DESC, id DESC
LIMIT ${SKU_LIMIT}`,
    ["active", ...codes],
  );
  return ensureBoundedRows(rows, SKU_LIMIT).map(sku);
}

function ensureRelationClosure(
  relations: readonly SupplierSkuRelation[],
  suppliers: readonly SupplierSummary[],
  factories: readonly SupplierFactory[],
  skus: readonly SupplierSkuCatalogItem[],
): void {
  const supplierIds = new Set(suppliers.map((value) => value.id));
  const factoryIds = new Set(factories.map((value) => value.id));
  const skuCodes = new Set(skus.map((value) => value.code));
  if (
    relations.some(
      (value) =>
        !supplierIds.has(value.supplierId) ||
        !factoryIds.has(value.factoryId) ||
        !skuCodes.has(value.sku),
    )
  ) {
    invalidData();
  }
}

async function readSupplierSkus(
  database: QueryExecutor,
  scope: DataScope,
): Promise<SupplierSkusResponse> {
  const relations = await readRelations(database, scope, {
    activeOnly: false,
    limit: RELATION_LIMIT,
  });

  let supplierQuery: Promise<SupplierSummary[]>;
  let factoryQuery: Promise<SupplierFactory[]>;
  let skuQuery: Promise<SupplierSkuCatalogItem[]>;
  if (scope.kind === "internal") {
    supplierQuery = database
      .query<DataRow>(
        `${SUPPLIER_SUMMARY_COLUMNS}
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
      )
      .then((rows) =>
        ensureBoundedRows(rows, SUPPLIER_LIMIT).map(supplierSummary),
      );
    factoryQuery = database
      .query<DataRow>(
        `${FACTORY_COLUMNS}
ORDER BY updated_at DESC, id DESC
LIMIT ${FACTORY_LIMIT}`,
      )
      .then((rows) => ensureBoundedRows(rows, FACTORY_LIMIT).map(factory));
    skuQuery = database
      .query<DataRow>(
        `${SKU_COLUMNS}
WHERE status = ?
ORDER BY updated_at DESC, id DESC
LIMIT ${SKU_LIMIT}`,
        ["active"],
      )
      .then((rows) => ensureBoundedRows(rows, SKU_LIMIT).map(sku));
  } else if (scope.kind === "factory") {
    const relationSupplierIds = uniqueIntegers(
      relations.map((value) => value.supplierId),
    );
    supplierQuery = database
      .query<DataRow>(
        `${SUPPLIER_SUMMARY_COLUMNS}
WHERE managed_by_factory_id = ?${
          relationSupplierIds.length === 0
            ? ""
            : ` OR id IN (${placeholders(
                relationSupplierIds.length,
                RELATION_LIMIT,
              )})`
        }
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
        [scope.factoryId, ...relationSupplierIds],
      )
      .then((rows) =>
        ensureBoundedRows(rows, SUPPLIER_LIMIT).map(supplierSummary),
      );
    factoryQuery = database
      .query<DataRow>(
        `${FACTORY_COLUMNS}
WHERE id = ?
ORDER BY id DESC
LIMIT 1`,
        [scope.factoryId],
      )
      .then((rows) => ensureBoundedRows(rows, 1).map(factory));
    skuQuery = database
      .query<DataRow>(
        `${SKU_COLUMNS}
WHERE status = ?
ORDER BY updated_at DESC, id DESC
LIMIT ${SKU_LIMIT}`,
        ["active"],
      )
      .then((rows) => ensureBoundedRows(rows, SKU_LIMIT).map(sku));
  } else if (scope.kind === "supplier") {
    const supplierIds = uniqueIntegers([
      scope.supplierId,
      ...relations.map((value) => value.supplierId),
    ]);
    supplierQuery = readSupplierSummariesByIds(database, supplierIds);
    factoryQuery = readFactoriesByIds(
      database,
      uniqueIntegers(relations.map((value) => value.factoryId)),
    );
    skuQuery = readSkusByCodes(
      database,
      uniqueStrings(relations.map((value) => value.sku)),
    );
  } else {
    const supplierIds = uniqueIntegers([
      scope.supplierId,
      ...relations.map((value) => value.supplierId),
    ]);
    supplierQuery = database
      .query<DataRow>(
        `${SUPPLIER_SUMMARY_COLUMNS}
WHERE managed_by_factory_id = ? OR id IN (${placeholders(
          supplierIds.length,
          RELATION_LIMIT + 1,
        )})
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
        [scope.factoryId, ...supplierIds],
      )
      .then((rows) =>
        ensureBoundedRows(rows, SUPPLIER_LIMIT).map(supplierSummary),
      );
    factoryQuery = readFactoriesByIds(
      database,
      uniqueIntegers([
        scope.factoryId,
        ...relations.map((value) => value.factoryId),
      ]),
    );
    skuQuery = database
      .query<DataRow>(
        `${SKU_COLUMNS}
WHERE status = ?
ORDER BY updated_at DESC, id DESC
LIMIT ${SKU_LIMIT}`,
        ["active"],
      )
      .then((rows) => ensureBoundedRows(rows, SKU_LIMIT).map(sku));
  }

  const [suppliers, factories, skus] = await Promise.all([
    supplierQuery,
    factoryQuery,
    skuQuery,
  ]);
  ensureRelationClosure(relations, suppliers, factories, skus);
  return { relations, suppliers, factories, skus };
}

async function readAgreements(
  database: QueryExecutor,
  supplierIds: readonly number[],
): Promise<SupplierPriceAgreement[]> {
  if (supplierIds.length === 0) return [];
  const rows = await database.query<DataRow>(
    `SELECT
  id,
  supplier_id AS supplierId,
  sku,
  currency,
  unit_price_tax_included_minor AS unitPriceTaxIncludedMinor,
  unit_price_tax_excluded_minor AS unitPriceTaxExcludedMinor,
  tax_rate_bps AS taxRateBps,
  effective_from AS effectiveFrom,
  effective_to AS effectiveTo,
  status
FROM core_price_agreements
WHERE supplier_id IN (${placeholders(supplierIds.length, PRICE_RELATION_LIMIT)})
ORDER BY effective_from DESC, id DESC
LIMIT ${AGREEMENT_LIMIT}`,
    supplierIds,
  );
  return ensureBoundedRows(rows, AGREEMENT_LIMIT).map(agreement);
}

async function readPriceRequests(
  database: QueryExecutor,
  supplierIds: readonly number[],
): Promise<SupplierPriceChangeRequest[]> {
  if (supplierIds.length === 0) return [];
  const rows = await database.query<DataRow>(
    `SELECT
  id,
  current_agreement_id AS currentAgreementId,
  supplier_id AS supplierId,
  sku,
  proposed_tax_included_minor AS proposedTaxIncludedMinor,
  proposed_tax_excluded_minor AS proposedTaxExcludedMinor,
  proposed_tax_rate_bps AS proposedTaxRateBps,
  proposed_effective_from AS proposedEffectiveFrom,
  reason,
  decision
FROM core_price_change_requests
WHERE supplier_id IN (${placeholders(supplierIds.length, PRICE_RELATION_LIMIT)})
ORDER BY id DESC
LIMIT ${PRICE_REQUEST_LIMIT}`,
    supplierIds,
  );
  return ensureBoundedRows(rows, PRICE_REQUEST_LIMIT).map(priceRequest);
}

interface DemandRow {
  dueDate: string;
  quantity: number;
  sku: string;
  supplierId: number;
}

function demandRow(row: DataRow): DemandRow {
  return {
    dueDate: day(row.dueDate),
    quantity: integer(row.quantity),
    sku: string(row.sku),
    supplierId: integer(row.supplierId),
  };
}

async function readDemand(
  database: QueryExecutor,
  supplierIds: readonly number[],
): Promise<DemandRow[]> {
  if (supplierIds.length === 0) return [];
  const rows = await database.query<DataRow>(
    `SELECT
  items.supplier_id AS supplierId,
  items.sku,
  items.quantity,
  items.due_date AS dueDate
FROM order_items AS items
INNER JOIN purchase_orders AS orders ON orders.id = items.purchase_order_id
WHERE items.supplier_id IN (${placeholders(supplierIds.length, PRICE_RELATION_LIMIT)})
  AND items.due_date IS NOT NULL
  AND orders.status NOT IN (?, ?, ?)
ORDER BY items.id DESC
LIMIT ${ORDER_ITEM_LIMIT}`,
    [...supplierIds, "completed", "closed", "cancelled"],
  );
  return ensureBoundedRows(rows, ORDER_ITEM_LIMIT).map(demandRow);
}

function capacityRisks(
  relations: readonly SupplierSkuRelation[],
  demandRows: readonly DemandRow[],
): SupplierCapacityRisk[] {
  const demand = new Map<string, number>();
  for (const item of demandRows) {
    for (const period of [item.dueDate, item.dueDate.slice(0, 7)]) {
      const key = `${item.supplierId}|${item.sku}|${period}`;
      demand.set(key, (demand.get(key) ?? 0) + item.quantity);
    }
  }

  const risks: SupplierCapacityRisk[] = [];
  for (const value of relations) {
    for (const [periodType, capacity] of [
      ["day", value.dailyCapacity],
      ["month", value.monthlyCapacity],
    ] as const) {
      if (capacity === null) continue;
      for (const [key, quantity] of demand) {
        const [supplierId, skuCode, period] = key.split("|");
        if (
          supplierId === undefined ||
          skuCode === undefined ||
          period === undefined ||
          (periodType === "day" ? period.length !== 10 : period.length !== 7) ||
          Number(supplierId) !== value.supplierId ||
          skuCode !== value.sku ||
          quantity <= capacity
        ) {
          continue;
        }
        risks.push({
          relationId: value.id,
          factoryId: value.factoryId,
          supplierId: value.supplierId,
          sku: value.sku,
          periodType,
          period,
          demand: quantity,
          capacity,
          excess: quantity - capacity,
        });
        if (risks.length > RISK_LIMIT) return invalidData();
      }
    }
  }
  return risks.sort(
    (left, right) =>
      right.relationId - left.relationId ||
      right.period.localeCompare(left.period) ||
      left.periodType.localeCompare(right.periodType),
  );
}

async function readPriceSuppliers(
  database: QueryExecutor,
  scope: DataScope,
  relations: readonly SupplierSkuRelation[],
): Promise<SupplierSummary[]> {
  if (scope.kind === "internal") {
    const rows = await database.query<DataRow>(
      `${SUPPLIER_SUMMARY_COLUMNS}
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
    );
    return ensureBoundedRows(rows, SUPPLIER_LIMIT).map(supplierSummary);
  }
  const ids = uniqueIntegers([
    ...(scope.kind === "supplier" || scope.kind === "factory_supplier"
      ? [scope.supplierId]
      : []),
    ...relations.map((value) => value.supplierId),
  ]).slice(0, SUPPLIER_LIMIT);
  return readSupplierSummariesByIds(database, ids);
}

async function readPriceSkus(
  database: QueryExecutor,
  scope: DataScope,
  relations: readonly SupplierSkuRelation[],
): Promise<SupplierSkuCatalogItem[]> {
  if (scope.kind === "internal") {
    const rows = await database.query<DataRow>(
      `${SKU_COLUMNS}
WHERE status = ?
ORDER BY updated_at DESC, id DESC
LIMIT ${SKU_LIMIT}`,
      ["active"],
    );
    return ensureBoundedRows(rows, SKU_LIMIT).map(sku);
  }
  return readSkusByCodes(
    database,
    uniqueStrings(relations.map((value) => value.sku)).slice(0, SKU_LIMIT),
  );
}

async function readRelationsBySupplierIds(
  database: QueryExecutor,
  supplierIds: readonly number[],
): Promise<SupplierSkuRelation[]> {
  if (supplierIds.length === 0) return [];
  const rows = await database.query<DataRow>(
    `${RELATION_COLUMNS}
WHERE status = ?
  AND supplier_id IN (${placeholders(
    supplierIds.length,
    SUPPLIER_LIMIT,
  )})
ORDER BY id DESC
LIMIT ${PRICE_RELATION_LIMIT}`,
    ["active", ...supplierIds],
  );
  return ensureBoundedRows(rows, PRICE_RELATION_LIMIT).map(relation);
}

async function readSupplierPrices(
  database: QueryExecutor,
  scope: DataScope,
): Promise<SupplierPricesResponse> {
  let relations: SupplierSkuRelation[];
  let suppliers: SupplierSummary[];
  if (scope.kind === "internal") {
    suppliers = await readPriceSuppliers(database, scope, []);
    relations = await readRelationsBySupplierIds(
      database,
      suppliers.map((value) => value.id),
    );
  } else {
    relations = await readRelations(database, scope, {
      activeOnly: true,
      limit: PRICE_RELATION_LIMIT,
    });
    suppliers = await readPriceSuppliers(database, scope, relations);
  }
  const skus = await readPriceSkus(database, scope, relations);
  const supplierIds =
    scope.kind === "internal"
      ? uniqueIntegers(suppliers.map((value) => value.id))
      : scope.kind === "factory"
        ? uniqueIntegers(relations.map((value) => value.supplierId))
        : scope.kind === "supplier"
          ? [scope.supplierId]
          : uniqueIntegers([
              scope.supplierId,
              ...relations.map((value) => value.supplierId),
            ]);
  const [agreements, requests, demand] = await Promise.all([
    readAgreements(database, supplierIds),
    readPriceRequests(database, supplierIds),
    readDemand(database, supplierIds),
  ]);
  const allowedSupplierIds = new Set(supplierIds);
  if (
    agreements.some((value) => !allowedSupplierIds.has(value.supplierId)) ||
    requests.some((value) => !allowedSupplierIds.has(value.supplierId)) ||
    demand.some((value) => !allowedSupplierIds.has(value.supplierId))
  ) {
    invalidData();
  }
  return {
    agreements,
    requests,
    suppliers,
    skus,
    relations,
    risks: capacityRisks(relations, demand),
  };
}

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function localDate(value: string | Date): string | null {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = Object.fromEntries(
    shanghaiDateFormatter
      .formatToParts(parsed)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.year;
  const month = parts.month;
  const localDay = parts.day;
  return year !== undefined && month !== undefined && localDay !== undefined
    ? `${year}-${month}-${localDay}`
    : null;
}

function quarterFromDate(value: string): string | null {
  const [year, month] = value.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

function nowDate(options: SuppliersModuleOptions): Date {
  const value = options.now?.() ?? new Date();
  if (Number.isNaN(value.getTime())) return invalidData();
  return value;
}

function currentQuarter(now: Date): string {
  const today = localDate(now);
  if (today === null) return invalidData();
  return quarterFromDate(today) ?? invalidData();
}

function shanghaiQuarterBounds(quarter: string): {
  endExclusive: string;
  startInclusive: string;
} {
  const match = /^(\d{4})-Q([1-4])$/u.exec(quarter);
  if (match === null) return invalidData();
  const year = Number(match[1]);
  const quarterNumber = Number(match[2]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(quarterNumber)) {
    return invalidData();
  }
  const startMonth = (quarterNumber - 1) * 3 + 1;
  const endYear = quarterNumber === 4 ? year + 1 : year;
  const endMonth = quarterNumber === 4 ? 1 : startMonth + 3;
  return {
    startInclusive: `${String(year).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`,
    endExclusive: `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-01`,
  };
}

interface PerformanceSupplierRow {
  id: number;
  code: string;
  managedByFactoryId: number | null;
  name: string;
  tier: number;
}

interface PerformanceReviewRow {
  comment: string;
  reviewType: SupplierReviewType;
  score: number;
  supplierId: number;
  tags: string[];
}

interface PerformanceDeliveryRow {
  plannedShipAt: string;
  shippedAt: string | null;
  supplierId: number | null;
}

function performanceSupplier(row: DataRow): PerformanceSupplierRow {
  return {
    id: integer(row.id),
    code: string(row.code),
    managedByFactoryId: nullableInteger(row.managedByFactoryId),
    name: string(row.name),
    tier: integer(row.tier, { maximum: 3 }),
  };
}

function tags(value: unknown): string[] {
  const encoded = string(value, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return invalidData();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 100 ||
    parsed.some((tag) => typeof tag !== "string")
  ) {
    return invalidData();
  }
  return parsed;
}

function performanceReview(row: DataRow): PerformanceReviewRow {
  return {
    comment: string(row.comment, true),
    reviewType: enumeration(row.reviewType, ["satisfaction", "sampling"]),
    score: integer(row.score, { maximum: 5 }),
    supplierId: integer(row.supplierId),
    tags: tags(row.tagsJson),
  };
}

function performanceDelivery(row: DataRow): PerformanceDeliveryRow {
  return {
    plannedShipAt: string(row.plannedShipAt),
    shippedAt: nullableString(row.shippedAt),
    supplierId:
      row.supplierId === null ? null : integer(row.supplierId),
  };
}

function performanceWeights(row: DataRow): {
  tier: number;
  weights: SupplierPerformanceWeights;
} {
  const tier = integer(row.tier, { maximum: 3 });
  const weights = {
    delivery: integer(row.deliveryWeightBps, { allowZero: true }),
    quality: integer(row.qualityWeightBps, { allowZero: true }),
    exception: integer(row.exceptionWeightBps, { allowZero: true }),
    preparation: integer(row.preparationWeightBps, { allowZero: true }),
    satisfaction: integer(row.satisfactionWeightBps, { allowZero: true }),
    sampling: integer(row.samplingWeightBps, { allowZero: true }),
  };
  if (
    Object.values(weights).reduce((sum, value) => sum + value, 0) !== 10_000 ||
    (tier !== 1 && weights.satisfaction !== 0)
  ) {
    return invalidData();
  }
  return { tier, weights };
}

function average(values: readonly number[]): number | null {
  return values.length > 0
    ? Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) *
          20 *
          10,
      ) / 10
    : null;
}

function performanceResponse(
  context: SupplierAccessContext,
  scope: DataScope,
  quarter: string,
  supplierRows: readonly PerformanceSupplierRow[],
  reviewRows: readonly PerformanceReviewRow[],
  weightRows: readonly { tier: number; weights: SupplierPerformanceWeights }[],
  deliveryRows: readonly PerformanceDeliveryRow[],
  today: string,
): SupplierPerformanceResponse {
  const selectedWeights = new Map<number, SupplierPerformanceWeights>();
  for (const row of weightRows) {
    if (!selectedWeights.has(row.tier)) {
      selectedWeights.set(row.tier, row.weights);
    }
  }

  const deliveryBySupplier = new Map<
    number,
    { onTime: number; total: number }
  >();
  for (const row of deliveryRows) {
    if (row.supplierId === null) continue;
    const plannedDate = localDate(row.plannedShipAt);
    if (plannedDate === null) return invalidData();
    if (quarterFromDate(plannedDate) !== quarter) continue;
    const shippedDate =
      row.shippedAt === null ? null : localDate(row.shippedAt);
    if (row.shippedAt !== null && shippedDate === null) return invalidData();
    if (shippedDate === null && plannedDate >= today) continue;
    const stats = deliveryBySupplier.get(row.supplierId) ?? {
      total: 0,
      onTime: 0,
    };
    stats.total += 1;
    if (shippedDate === plannedDate) stats.onTime += 1;
    deliveryBySupplier.set(row.supplierId, stats);
  }

  const raw = supplierRows.map((supplier) => {
    const own = reviewRows.filter((row) => row.supplierId === supplier.id);
    const satisfaction = average(
      own
        .filter((row) => row.reviewType === "satisfaction")
        .map((row) => row.score),
    );
    const sampling = average(
      own
        .filter((row) => row.reviewType === "sampling")
        .map((row) => row.score),
    );
    const deliveryStats = deliveryBySupplier.get(supplier.id);
    const delivery =
      deliveryStats !== undefined && deliveryStats.total > 0
        ? Math.round((deliveryStats.onTime / deliveryStats.total) * 1_000) / 10
        : null;
    const metrics = {
      delivery,
      quality: null,
      exception: null,
      preparation: null,
      satisfaction: supplier.tier === 1 ? satisfaction : null,
      sampling,
    };
    const weights =
      selectedWeights.get(supplier.tier) ?? DEFAULT_WEIGHTS[supplier.tier];
    if (weights === undefined) return invalidData();
    const available = METRIC_KEYS.filter(
      (key) => metrics[key] !== null && weights[key] > 0,
    );
    const denominator = available.reduce(
      (sum, key) => sum + weights[key],
      0,
    );
    const score =
      denominator > 0
        ? Math.round(
            (available.reduce(
              (sum, key) => sum + (metrics[key] ?? 0) * weights[key],
              0,
            ) /
              denominator) *
              10,
          ) / 10
        : null;
    const reveal =
      scope.kind === "internal" ||
      ((scope.kind === "supplier" || scope.kind === "factory_supplier") &&
        scope.supplierId === supplier.id) ||
      ((scope.kind === "factory" || scope.kind === "factory_supplier") &&
        supplier.managedByFactoryId === scope.factoryId);
    const comments: SupplierPerformanceComment[] = reveal
      ? own
          .filter((row) => row.comment.trim().length > 0)
          .map((row) => ({
            type: row.reviewType,
            comment: row.comment,
            tags: row.tags,
          }))
      : [];
    return {
      supplierId: reveal ? supplier.id : null,
      supplierCode: reveal ? supplier.code : null,
      supplierName: reveal ? supplier.name : null,
      tier: supplier.tier,
      score,
      metrics,
      automaticMetricEvidence: {
        delivery: {
          evaluatedBatches: deliveryStats?.total ?? 0,
          onTimeBatches: deliveryStats?.onTime ?? 0,
        },
      },
      reviewCounts: {
        satisfaction: own.filter(
          (row) => row.reviewType === "satisfaction",
        ).length,
        sampling: own.filter((row) => row.reviewType === "sampling").length,
      },
      comments,
      reveal,
    };
  });
  const rankings: SupplierPerformanceRanking[] = raw
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      displayName:
        row.reveal && row.supplierName !== null
          ? row.supplierName
          : `第${index + 1}名企业`,
    }));

  return {
    quarter,
    rankings,
    weights: [1, 2, 3].map((tier) => {
      const weights = selectedWeights.get(tier) ?? DEFAULT_WEIGHTS[tier];
      if (weights === undefined) return invalidData();
      return { tier, ...weights };
    }),
    canConfigure: context.roles.some((role) =>
      PERFORMANCE_CONFIGURATION_ROLES.has(role),
    ),
    canReview: context.roles.some((role) =>
      PERFORMANCE_REVIEW_ROLES.has(role),
    ),
    automaticMetricsPending: true,
  };
}

async function readPerformance(
  database: QueryExecutor,
  context: SupplierAccessContext,
  scope: DataScope,
  quarter: string,
  tier: number | null,
  today: string,
): Promise<SupplierPerformanceResponse> {
  const supplierParams: readonly (number | string)[] =
    tier === null ? ["active"] : ["active", tier];
  const supplierRowsPromise = database.query<DataRow>(
    `SELECT
  id,
  code,
  name,
  tier,
  managed_by_factory_id AS managedByFactoryId
FROM suppliers
WHERE status = ?
  AND tier IN (1, 2, 3)${tier === null ? "" : "\n  AND tier = ?"}
ORDER BY updated_at DESC, id DESC
LIMIT ${SUPPLIER_LIMIT}`,
    supplierParams,
  );
  const weightRowsPromise = database.query<DataRow>(
    `SELECT
  tier,
  delivery_weight_bps AS deliveryWeightBps,
  quality_weight_bps AS qualityWeightBps,
  exception_weight_bps AS exceptionWeightBps,
  preparation_weight_bps AS preparationWeightBps,
  satisfaction_weight_bps AS satisfactionWeightBps,
  sampling_weight_bps AS samplingWeightBps
FROM supplier_performance_weight_versions
WHERE status = ? AND effective_from <= ?
ORDER BY effective_from DESC, id DESC
LIMIT ${WEIGHT_LIMIT}`,
    ["active", today],
  );
  const [supplierRows, weightRows] = await Promise.all([
    supplierRowsPromise,
    weightRowsPromise,
  ]);
  const suppliers = ensureBoundedRows(supplierRows, SUPPLIER_LIMIT).map(
    performanceSupplier,
  );
  const visibleSupplierIds = uniqueIntegers(
    suppliers.map((value) => value.id),
  );
  const tierClause = tier === null ? "" : "\n  AND suppliers.tier = ?";
  const sharedScopeParams: readonly (number | string)[] = [
    "active",
    ...(tier === null ? [] : [tier]),
    ...visibleSupplierIds,
  ];
  const reviewRowsPromise: Promise<readonly DataRow[]> =
    visibleSupplierIds.length === 0
      ? Promise.resolve([])
      : database.query<DataRow>(
          `SELECT
  reviews.supplier_id AS supplierId,
  reviews.review_type AS reviewType,
  reviews.score,
  reviews.tags_json AS tagsJson,
  reviews.comment
FROM supplier_performance_reviews AS reviews
INNER JOIN suppliers AS suppliers ON suppliers.id = reviews.supplier_id
WHERE reviews.quarter = ?
  AND suppliers.status = ?
  AND suppliers.tier IN (1, 2, 3)${tierClause}
  AND reviews.supplier_id IN (${placeholders(
    visibleSupplierIds.length,
    SUPPLIER_LIMIT,
  )})
ORDER BY reviews.supplier_id ASC, reviews.review_type ASC, reviews.id ASC
LIMIT ${REVIEW_LIMIT}`,
          [quarter, ...sharedScopeParams],
        );
  const { startInclusive, endExclusive } = shanghaiQuarterBounds(quarter);
  const deliveryRowsPromise: Promise<readonly DataRow[]> =
    visibleSupplierIds.length === 0
      ? Promise.resolve([])
      : database.query<DataRow>(
          `SELECT
  items.supplier_id AS supplierId,
  batches.planned_ship_at AS plannedShipAt,
  batches.shipped_at AS shippedAt
FROM delivery_batches AS batches
INNER JOIN execution_orders AS executions
  ON executions.id = batches.execution_order_id
INNER JOIN order_items AS items
  ON items.id = executions.order_item_id
INNER JOIN suppliers AS suppliers
  ON suppliers.id = items.supplier_id
WHERE batches.planned_ship_at >= ?
  AND batches.planned_ship_at < ?
  AND suppliers.status = ?
  AND suppliers.tier IN (1, 2, 3)${tierClause}
  AND items.supplier_id IN (${placeholders(
    visibleSupplierIds.length,
    SUPPLIER_LIMIT,
  )})
ORDER BY batches.id DESC
LIMIT ${DELIVERY_LIMIT}`,
          [startInclusive, endExclusive, ...sharedScopeParams],
        );
  const [reviewRows, deliveryRows] = await Promise.all([
    reviewRowsPromise,
    deliveryRowsPromise,
  ]);
  const visibleSupplierIdSet = new Set(visibleSupplierIds);
  const reviews = ensureBoundedRows(reviewRows, REVIEW_LIMIT)
    .map(performanceReview)
    .filter((value) => visibleSupplierIdSet.has(value.supplierId));
  return performanceResponse(
    context,
    scope,
    quarter,
    suppliers,
    reviews,
    ensureBoundedRows(weightRows, WEIGHT_LIMIT).map(performanceWeights),
    ensureBoundedRows(deliveryRows, DELIVERY_LIMIT).map(performanceDelivery),
    today,
  );
}

function privateNoStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  reply.header("cache-control", "private, no-store");
  reply.header("pragma", "no-cache");
  reply.header("vary", "Cookie");
  done();
}

function addSchemas(app: FastifyInstance): void {
  for (const [id, schema] of [
    [suppliersSchemaId, suppliersResponseSchema],
    [supplierSkusSchemaId, supplierSkusResponseSchema],
    [supplierPricesSchemaId, supplierPricesResponseSchema],
    [supplierPerformanceSchemaId, supplierPerformanceResponseSchema],
  ] as const) {
    if (!app.getSchema(id)) app.addSchema(schema);
  }
}

function jsonRouteSchema(schemaId: string, tag: string, summary: string) {
  return {
    tags: [tag],
    summary,
    response: {
      200: { $ref: `${schemaId}#` },
      400: { $ref: `${apiErrorSchemaId}#` },
      401: { $ref: `${apiErrorSchemaId}#` },
      403: { $ref: `${apiErrorSchemaId}#` },
      503: { $ref: `${apiErrorSchemaId}#` },
      "5xx": { $ref: `${apiErrorSchemaId}#` },
    },
  } as const;
}

interface PerformanceQuery {
  format?: string;
  quarter?: string;
  tier?: number | string;
}

function performanceQuery(
  query: PerformanceQuery,
  now: Date,
  rawUrl: string,
): { format: "json" | "xlsx"; quarter: string; tier: number | null } {
  const rawParameters = new URL(rawUrl, "http://localhost").searchParams;
  if (
    [...rawParameters.keys()].some(
      (key) => !["format", "quarter", "tier"].includes(key),
    ) ||
    ["format", "quarter", "tier"].some(
      (key) => rawParameters.getAll(key).length > 1,
    )
  ) {
    return badRequest();
  }
  const quarter = query.quarter ?? currentQuarter(now);
  if (!QUARTER_PATTERN.test(quarter)) return badRequest();
  const tierValue = query.tier;
  let tier: number | null = null;
  if (tierValue !== undefined && tierValue !== "") {
    tier = Number(tierValue);
    if (!Number.isSafeInteger(tier) || tier < 1 || tier > 3) {
      return badRequest();
    }
  }
  if (query.format !== undefined && query.format !== "xlsx") {
    return badRequest();
  }
  return {
    format: query.format === "xlsx" ? "xlsx" : "json",
    quarter,
    tier,
  };
}

function previewPerformance(
  context: SupplierAccessContext,
  quarter: string,
): SupplierPerformanceResponse {
  return {
    quarter,
    rankings: [],
    weights: [1, 2, 3].map((tier) => {
      const weights = DEFAULT_WEIGHTS[tier];
      if (weights === undefined) return invalidData();
      return { tier, ...weights };
    }),
    canConfigure: context.roles.some((role) =>
      PERFORMANCE_CONFIGURATION_ROLES.has(role),
    ),
    canReview: context.roles.some((role) =>
      PERFORMANCE_REVIEW_ROLES.has(role),
    ),
    automaticMetricsPending: true,
    preview: true,
  };
}

export async function registerSuppliersModule(
  app: FastifyInstance,
  options: SuppliersModuleOptions,
): Promise<void> {
  addSchemas(app);

  app.get<{ Reply: SuppliersResponse }>(
    "/api/v1/suppliers",
    {
      onRequest: privateNoStore,
      schema: jsonRouteSchema(
        suppliersSchemaId,
        "suppliers",
        "Read supplier profiles within the caller organization scope",
      ),
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview) return { suppliers: [], preview: true };
      const scope = dataScope(access);
      return readSuppliers(requireDatabase(options), scope);
    },
  );

  app.get<{ Reply: SupplierSkusResponse }>(
    "/api/v1/supplier-skus",
    {
      onRequest: privateNoStore,
      schema: jsonRouteSchema(
        supplierSkusSchemaId,
        "suppliers",
        "Read supplier SKU relations and scoped reference data",
      ),
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview) return { relations: [], preview: true };
      const scope = dataScope(access);
      return readSupplierSkus(requireDatabase(options), scope);
    },
  );

  app.get<{ Reply: SupplierPricesResponse }>(
    "/api/v1/supplier-prices",
    {
      onRequest: privateNoStore,
      schema: jsonRouteSchema(
        supplierPricesSchemaId,
        "suppliers",
        "Read supplier price history and capacity risk within scope",
      ),
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview) {
        return {
          agreements: [],
          requests: [],
          suppliers: [],
          skus: [],
          relations: [],
          risks: [],
          preview: true,
        };
      }
      const scope = dataScope(access);
      if (options.audit === undefined) throw new SuppliersUnavailableError();
      const result = await readSupplierPrices(requireDatabase(options), scope);
      try {
        await options.audit(
          {
            action: "view",
            module: "supplier_prices",
            entityType: "price_list",
            entityId: "latest",
            sensitiveView: true,
          },
          auditActor(access),
          request,
        );
      } catch {
        throw new SuppliersUnavailableError();
      }
      return result;
    },
  );

  app.get<{ Querystring: PerformanceQuery }>(
    "/api/v1/supplier-performance",
    {
      onRequest: privateNoStore,
      schema: {
        tags: ["suppliers"],
        summary: "Read or export scoped supplier performance rankings",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            quarter: { type: "string", pattern: "^[0-9]{4}-Q[1-4]$" },
            tier: { type: "integer", minimum: 1, maximum: 3 },
            format: { type: "string", enum: ["xlsx"] },
          },
        },
        response: {
          200: {
            content: {
              "application/json": {
                schema: { $ref: `${supplierPerformanceSchemaId}#` },
              },
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          400: { $ref: `${apiErrorSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      const access = await options.authenticate(request);
      const now = nowDate(options);
      if (access.localPreview) {
        const query = performanceQuery(
          request.query,
          now,
          request.raw.url ?? "",
        );
        return previewPerformance(access, query.quarter);
      }
      const scope = dataScope(access);
      const query = performanceQuery(request.query, now, request.raw.url ?? "");
      if (
        query.format === "xlsx" &&
        (options.exportPerformance === undefined || options.audit === undefined)
      ) {
        throw new SuppliersUnavailableError();
      }
      const today = localDate(now);
      if (today === null) return invalidData();
      const result = await readPerformance(
        requireDatabase(options),
        access,
        scope,
        query.quarter,
        query.tier,
        today,
      );
      if (query.format === "json") return result;
      if (options.exportPerformance === undefined || options.audit === undefined) {
        return invalidData();
      }
      const watermark = `导出人：${access.name}（${access.email}）｜导出时间：${now.toLocaleString(
        "zh-CN",
        { timeZone: "Asia/Shanghai" },
      )}`;
      let bytes: Uint8Array;
      try {
        bytes = await options.exportPerformance({
          quarter: query.quarter,
          rankings: result.rankings,
          watermark,
        });
      } catch {
        throw new SuppliersUnavailableError();
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        return invalidData();
      }
      try {
        await options.audit(
          {
            action: "export_supplier_performance",
            module: "supplier_performance",
            entityType: "supplier_ranking",
            entityId: query.quarter,
            exported: true,
            sensitiveView: true,
            count: result.rankings.length,
          },
          auditActor(access),
          request,
        );
      } catch {
        throw new SuppliersUnavailableError();
      }
      return reply
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "content-disposition",
          `attachment; filename="supplier-performance-${query.quarter}.xlsx"`,
        )
        .send(Buffer.from(bytes));
    },
  );
}
