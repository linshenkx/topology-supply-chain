import type {
  SupplierFactory,
  SupplierPerformanceRanking,
  SupplierPriceAgreement,
  SupplierPriceChangeRequest,
  SupplierProfile,
  SupplierSkuCatalogItem,
  SupplierSkuRelation,
  SupplierSummary,
} from "@topology/contracts";
import type { FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "company_qc",
]);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const SUPPLIER_PROFILE_COLUMNS = `SELECT
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

export const SUPPLIER_SUMMARY_COLUMNS = `SELECT
  id,
  code,
  name,
  tier,
  managed_by_factory_id AS managedByFactoryId,
  status
FROM suppliers`;

export const FACTORY_COLUMNS = `SELECT
  id,
  code,
  name,
  status
FROM factories`;

export const RELATION_COLUMNS = `SELECT
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

export const SKU_COLUMNS = `SELECT
  id,
  code,
  name,
  item_type AS itemType,
  stock_unit AS stockUnit
FROM skus`;

export type SupplierAccessContext = Pick<
  AccessContext,
  | "email"
  | "factoryId"
  | "localPreview"
  | "name"
  | "roles"
  | "supplierId"
  | "userId"
>;
export type DataRow = Record<string, unknown>;
export type DataScope =
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

export function invalidData(): never {
  throw new SuppliersUnavailableError();
}

export function badRequest(): never {
  throw new SuppliersBadRequestError();
}

export function integer(
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

export function nullableInteger(
  value: unknown,
  options: { allowZero?: boolean } = {},
): number | null {
  if (value === null) return null;
  return integer(value, options);
}

export function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

export function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value, true);
}

export function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidData();
}

export function enumeration<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return invalidData();
  }
  return value as Value;
}

export function day(value: unknown): string {
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

export function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

export function placeholders(count: number, maximum: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

export function uniqueIntegers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function isPositiveSafeInteger(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

export function isInternal(context: SupplierAccessContext): boolean {
  return context.roles.some((role) => INTERNAL_ROLES.has(role));
}

export function auditActor(context: SupplierAccessContext): SupplierAuditActor {
  return {
    email: context.email,
    factoryId: context.factoryId,
    name: context.name,
    roles: [...context.roles],
    supplierId: context.supplierId,
    userId: context.userId,
  };
}

export function boundOrganizationId(value: number | null): number {
  if (!isPositiveSafeInteger(value)) throw new SuppliersForbiddenError();
  return value;
}

export function dataScope(context: SupplierAccessContext): DataScope {
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

export function requireDatabase(options: SuppliersModuleOptions): QueryExecutor {
  if (options.database === undefined) throw new SuppliersUnavailableError();
  return options.database;
}

export function supplierProfile(row: DataRow): SupplierProfile {
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

export function supplierSummary(row: DataRow): SupplierSummary {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    tier: nullableInteger(row.tier),
    managedByFactoryId: nullableInteger(row.managedByFactoryId),
    status: string(row.status),
  };
}

export function factory(row: DataRow): SupplierFactory {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    status: string(row.status),
  };
}

export function sku(row: DataRow): SupplierSkuCatalogItem {
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

export function relation(row: DataRow): SupplierSkuRelation {
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

export function agreement(row: DataRow): SupplierPriceAgreement {
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

export function priceRequest(row: DataRow): SupplierPriceChangeRequest {
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
