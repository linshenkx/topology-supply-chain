import {
  apiErrorSchemaId,
  masterDataResponseSchema,
  masterDataSchemaId,
  type MasterDataBom,
  type MasterDataBomApprovalStatus,
  type MasterDataBomComponent,
  type MasterDataBomLifecycleStatus,
  type MasterDataResponse,
  type MasterDataSku,
  type MasterDataSkuItemType,
  type MasterDataUnitConversion,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const FULL_ACCESS_ROLES = new Set(["admin", "supply_chain", "company_qc"]);
const FACTORY_ROLE = "factory";

const SKU_LIMIT = 500;
const BOM_LIMIT = 500;
const CONVERSION_LIMIT = 1_000;
const COMPONENT_LIMIT = 2_000;

const SKU_COLUMNS = `SELECT
  id,
  code,
  name,
  item_type AS itemType,
  stock_unit AS stockUnit,
  overproduction_tolerance_bps AS overproductionToleranceBps,
  purchase_over_tolerance_bps AS purchaseOverToleranceBps,
  purchase_under_tolerance_bps AS purchaseUnderToleranceBps,
  status,
  verification_status AS verificationStatus
FROM skus`;

const CONVERSION_COLUMNS = `SELECT
  conversions.id,
  conversions.sku_id AS skuId,
  conversions.purchase_unit AS purchaseUnit,
  conversions.stock_unit AS stockUnit,
  conversions.purchase_unit_quantity AS purchaseUnitQuantity,
  conversions.stock_unit_quantity AS stockUnitQuantity,
  conversions.effective_from AS effectiveFrom,
  conversions.status
FROM sku_unit_conversions AS conversions`;

const BOM_COLUMNS = `SELECT
  id,
  finished_sku AS finishedSku,
  version,
  effective_from AS effectiveFrom,
  effective_to AS effectiveTo,
  approval_status AS approvalStatus,
  overlap_allowed AS overlapAllowed,
  overlap_reason AS overlapReason,
  active
FROM product_boms`;

const COMPONENT_COLUMNS = `SELECT
  components.id,
  components.bom_id AS bomId,
  components.component_sku AS componentSku,
  components.item_type AS itemType,
  components.quantity_per_finished AS quantityPerFinished,
  components.is_core AS isCore,
  components.issue_tolerance_bps AS issueToleranceBps,
  components.consumption_tolerance_bps AS consumptionToleranceBps,
  components.loss_tolerance_bps AS lossToleranceBps
FROM bom_components AS components`;

type MasterDataAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles"
>;
type DataScope = "factory" | "full";
type DataRow = Record<string, unknown>;
type MasterDataApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";
interface MasterDataApprovalSummary {
  requestNo: string;
  status: MasterDataApprovalRequestStatus;
  requestedAt: string;
  reviewedAt: string | null;
  reviewComment: string | null;
}
interface SkuApprovalRow extends DataRow {
  requestNo: string;
  requestedAt: string;
  reviewComment: string | null;
  reviewedAt: string | null;
  skuId: number;
  status: string;
}

export interface MasterDataModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<MasterDataAccessContext>;
  database?: QueryExecutor;
  now?: () => Date;
}

export class MasterDataForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Master data access forbidden");
    this.name = "MasterDataForbiddenError";
  }
}

export class MasterDataUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Master data unavailable");
    this.name = "MasterDataUnavailableError";
  }
}

function invalidData(): never {
  throw new MasterDataUnavailableError();
}

function integer(
  value: unknown,
  options: { allowZero?: boolean } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (options.allowZero === true ? 0 : 1)
  ) {
    return invalidData();
  }

  return value;
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

function approvalSummary(row: SkuApprovalRow): MasterDataApprovalSummary {
  return {
    requestNo: string(row.requestNo),
    status: enumeration<MasterDataApprovalRequestStatus>(row.status, [
      "pending",
      "approved",
      "rejected",
      "cancelled",
    ]),
    requestedAt: string(row.requestedAt),
    reviewedAt: nullableString(row.reviewedAt),
    reviewComment: nullableString(row.reviewComment),
  };
}

function sku(
  row: DataRow,
  latestApproval: MasterDataApprovalSummary | null,
): MasterDataSku {
  return {
    id: integer(row.id),
    code: string(row.code),
    name: string(row.name),
    itemType:
      row.itemType === null
        ? null
        : enumeration<Exclude<MasterDataSkuItemType, null>>(row.itemType, [
            "finished",
            "auxiliary",
            "component",
          ]),
    stockUnit: nullableString(row.stockUnit),
    overproductionToleranceBps: integer(row.overproductionToleranceBps, {
      allowZero: true,
    }),
    purchaseOverToleranceBps: integer(row.purchaseOverToleranceBps, {
      allowZero: true,
    }),
    purchaseUnderToleranceBps: integer(row.purchaseUnderToleranceBps, {
      allowZero: true,
    }),
    status: enumeration(row.status, ["draft", "active", "inactive"]),
    verificationStatus: enumeration(row.verificationStatus, [
      "pending",
      "approved",
      "rejected",
    ]),
    latestApproval,
  };
}

function conversion(row: DataRow): MasterDataUnitConversion {
  return {
    id: integer(row.id),
    skuId: integer(row.skuId),
    purchaseUnit: string(row.purchaseUnit),
    stockUnit: string(row.stockUnit),
    purchaseUnitQuantity: integer(row.purchaseUnitQuantity),
    stockUnitQuantity: integer(row.stockUnitQuantity),
    effectiveFrom: string(row.effectiveFrom),
    status: enumeration(row.status, ["active", "inactive"]),
  };
}

function bomLifecycleStatus(
  bom: Omit<MasterDataBom, "lifecycleStatus">,
  today: string,
): MasterDataBomLifecycleStatus {
  if (!bom.active) return "inactive";
  if (bom.approvalStatus !== "approved") return bom.approvalStatus;
  if (bom.effectiveFrom > today) return "future";
  if (bom.effectiveTo !== null && bom.effectiveTo < today) return "expired";
  return "effective";
}

function bom(row: DataRow, today: string): MasterDataBom {
  const value: Omit<MasterDataBom, "lifecycleStatus"> = {
    id: integer(row.id),
    finishedSku: string(row.finishedSku),
    version: string(row.version),
    effectiveFrom: string(row.effectiveFrom),
    effectiveTo: nullableString(row.effectiveTo),
    approvalStatus: enumeration<MasterDataBomApprovalStatus>(
      row.approvalStatus,
      ["draft", "pending", "approved", "rejected"],
    ),
    overlapAllowed: boolean(row.overlapAllowed),
    overlapReason: string(row.overlapReason, true),
    active: boolean(row.active),
  };

  return {
    ...value,
    lifecycleStatus: bomLifecycleStatus(value, today),
  };
}

function component(row: DataRow): MasterDataBomComponent {
  return {
    id: integer(row.id),
    bomId: integer(row.bomId),
    componentSku: string(row.componentSku),
    itemType: enumeration(row.itemType, ["auxiliary", "component"]),
    quantityPerFinished: integer(row.quantityPerFinished),
    isCore: boolean(row.isCore),
    issueToleranceBps: integer(row.issueToleranceBps, { allowZero: true }),
    consumptionToleranceBps: integer(row.consumptionToleranceBps, {
      allowZero: true,
    }),
    lossToleranceBps: integer(row.lossToleranceBps, { allowZero: true }),
  };
}

function resolveDataScope(context: MasterDataAccessContext): DataScope {
  if (context.roles.some((role) => FULL_ACCESS_ROLES.has(role))) {
    return "full";
  }

  if (
    context.roles.includes(FACTORY_ROLE) &&
    context.factoryId !== null &&
    Number.isSafeInteger(context.factoryId) &&
    context.factoryId > 0
  ) {
    return "factory";
  }

  throw new MasterDataForbiddenError();
}

function isoDay(now: () => Date): string {
  const value = now();
  if (Number.isNaN(value.getTime())) return invalidData();
  return value.toISOString().slice(0, 10);
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > SKU_LIMIT) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function ensureClosedChildren<Child extends { bomId?: number; skuId?: number }>(
  rows: readonly Child[],
  parentIds: ReadonlySet<number>,
  parentKey: "bomId" | "skuId",
): readonly Child[] {
  if (rows.some((row) => !parentIds.has(row[parentKey] ?? -1))) {
    return invalidData();
  }
  return rows;
}

async function readConversions(
  database: QueryExecutor,
  skuIds: readonly number[],
): Promise<MasterDataUnitConversion[]> {
  if (skuIds.length === 0) return [];

  const rows = await database.query<DataRow>(
    `${CONVERSION_COLUMNS}
WHERE conversions.sku_id IN (${placeholders(skuIds.length)})
ORDER BY conversions.sku_id ASC, conversions.id ASC
LIMIT ${CONVERSION_LIMIT + 1}`,
    skuIds,
  );
  const values = ensureBoundedRows(rows, CONVERSION_LIMIT).map(conversion);
  return [
    ...ensureClosedChildren(values, new Set(skuIds), "skuId"),
  ];
}

async function readLatestSkuApprovals(
  database: QueryExecutor,
  skuIds: readonly number[],
): Promise<Map<number, MasterDataApprovalSummary>> {
  if (skuIds.length === 0) return new Map();

  const rows = await database.query<SkuApprovalRow>(
    `SELECT approvals.entity_id AS skuId,
            approvals.request_no AS requestNo,
            approvals.status,
            approvals.requested_at AS requestedAt,
            approvals.reviewed_at AS reviewedAt,
            approvals.review_comment AS reviewComment
     FROM approval_requests AS approvals
     JOIN (
       SELECT entity_id, MAX(id) AS id
       FROM approval_requests
       WHERE workflow_type = ? AND entity_type = ? AND entity_id IN (${placeholders(skuIds.length)})
       GROUP BY entity_id
     ) AS latest ON latest.id = approvals.id
     ORDER BY approvals.entity_id ASC`,
    ["sku_verification", "sku", ...skuIds],
  );
  return new Map(
    rows.map((row) => [integer(row.skuId), approvalSummary(row)]),
  );
}

async function readComponents(
  database: QueryExecutor,
  bomIds: readonly number[],
): Promise<MasterDataBomComponent[]> {
  if (bomIds.length === 0) return [];

  const rows = await database.query<DataRow>(
    `${COMPONENT_COLUMNS}
WHERE components.bom_id IN (${placeholders(bomIds.length)})
ORDER BY components.bom_id ASC, components.id ASC
LIMIT ${COMPONENT_LIMIT + 1}`,
    bomIds,
  );
  const values = ensureBoundedRows(rows, COMPONENT_LIMIT).map(component);
  return [
    ...ensureClosedChildren(values, new Set(bomIds), "bomId"),
  ];
}

async function readMasterData(
  database: QueryExecutor,
  scope: DataScope,
  today: string,
): Promise<MasterDataResponse> {
  const skuQuery =
    scope === "full"
      ? database.query<DataRow>(
          `${SKU_COLUMNS}\nORDER BY updated_at DESC, id DESC\nLIMIT ${SKU_LIMIT}`,
        )
      : database.query<DataRow>(
          `${SKU_COLUMNS}\nWHERE status = ?\nORDER BY updated_at DESC, id DESC\nLIMIT ${SKU_LIMIT}`,
          ["active"],
        );
  const bomQuery =
    scope === "full"
      ? database.query<DataRow>(
          `${BOM_COLUMNS}\nORDER BY updated_at DESC, id DESC\nLIMIT ${BOM_LIMIT}`,
        )
      : database.query<DataRow>(
          `${BOM_COLUMNS}\nWHERE approval_status = ? AND active = ?\nORDER BY updated_at DESC, id DESC\nLIMIT ${BOM_LIMIT}`,
          ["approved", 1],
        );

  const [skuRows, bomRows] = await Promise.all([skuQuery, bomQuery]);
  const boundedSkuRows = ensureBoundedRows(skuRows, SKU_LIMIT);
  const skuIds = boundedSkuRows.map((row) => integer(row.id));
  const approvals = await readLatestSkuApprovals(database, skuIds);
  const skus = boundedSkuRows.map((row) =>
    sku(row, approvals.get(integer(row.id)) ?? null),
  );
  const boms = ensureBoundedRows(bomRows, BOM_LIMIT).map((row) =>
    bom(row, today),
  );
  const [conversions, components] = await Promise.all([
    readConversions(
      database,
      skus.map((row) => row.id),
    ),
    readComponents(
      database,
      boms.map((row) => row.id),
    ),
  ]);

  return { skus, conversions, boms, components };
}

export async function registerMasterDataModule(
  app: FastifyInstance,
  options: MasterDataModuleOptions,
): Promise<void> {
  if (!app.getSchema(masterDataSchemaId)) {
    app.addSchema(masterDataResponseSchema);
  }

  app.get<{ Reply: MasterDataResponse }>(
    "/api/v1/master-data",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["master-data"],
        summary: "Read SKU and BOM master data",
        response: {
          200: { $ref: `${masterDataSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview) {
        return {
          skus: [],
          conversions: [],
          boms: [],
          components: [],
          preview: true,
        };
      }

      const scope = resolveDataScope(access);
      if (options.database === undefined) {
        throw new MasterDataUnavailableError();
      }

      return readMasterData(
        options.database,
        scope,
        isoDay(options.now ?? (() => new Date())),
      );
    },
  );
}
