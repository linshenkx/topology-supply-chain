import {
  apiErrorSchemaId,
  productionOrdersResponseSchema,
  productionOrdersSchemaId,
  type ProductionBom,
  type ProductionBomComponent,
  type ProductionFactory,
  type ProductionMaterialLine,
  type ProductionOrder,
  type ProductionOrderItem,
  type ProductionOrderOption,
  type ProductionOrdersResponse,
  type ProductionPurchaseOrder,
  type ProductionReport,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  QueryExecutor,
  QueryParameters,
} from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set([
  "admin",
  "supply_chain",
  "factory",
  "company_qc",
]);
const INTERNAL_ROLES = new Set(["admin", "supply_chain", "company_qc"]);
const ORDER_LIMIT = 200;
const ITEM_LIMIT = 1_000;
const PURCHASE_ORDER_LIMIT = ITEM_LIMIT + ORDER_LIMIT;
const FACTORY_LIMIT = 500;
const BOM_LIMIT = 500;
const MATERIAL_LIMIT = 2_000;
const REPORT_LIMIT = 1_000;
const COMPONENT_LIMIT = 2_000;

const ORDER_COLUMNS = `SELECT
  orders.id,
  orders.execution_no AS executionNo,
  orders.order_item_id AS orderItemId,
  orders.factory_id AS factoryId,
  orders.bom_id AS bomId,
  orders.planned_quantity AS plannedQuantity,
  orders.completed_quantity AS completedQuantity,
  orders.status,
  orders.planned_start_date AS plannedStartDate,
  orders.planned_finish_date AS plannedFinishDate
FROM execution_orders AS orders`;

const ITEM_COLUMNS = `SELECT
  items.id,
  items.purchase_order_id AS purchaseOrderId,
  items.sku,
  items.product_name AS productName,
  items.item_type AS itemType,
  items.quantity
FROM order_items AS items`;

const FACTORY_OPTION_ITEM_COLUMNS = `SELECT
  items.id,
  items.purchase_order_id AS purchaseOrderId,
  items.sku,
  items.product_name AS productName,
  items.item_type AS itemType,
  SUM(links.allocated_quantity) AS quantity
FROM order_items AS items
INNER JOIN purchase_plan_order_links AS links
  ON links.order_item_id = items.id
INNER JOIN purchase_plan_items AS plan_items
  ON plan_items.id = links.purchase_plan_item_id`;

const PURCHASE_ORDER_COLUMNS = `SELECT
  purchases.id,
  purchases.order_no AS orderNo
FROM purchase_orders AS purchases`;

const FACTORY_COLUMNS = `SELECT
  factories.id,
  factories.name,
  factories.status
FROM factories`;

const BOM_COLUMNS = `SELECT
  boms.id,
  boms.finished_sku AS finishedSku,
  boms.version,
  boms.approval_status AS approvalStatus,
  boms.active
FROM product_boms AS boms`;

const MATERIAL_COLUMNS = `SELECT
  materials.id,
  materials.execution_order_id AS executionOrderId,
  materials.bom_component_id AS bomComponentId,
  materials.theoretical_quantity AS theoreticalQuantity,
  materials.issued_quantity AS issuedQuantity,
  materials.consumed_quantity AS consumedQuantity,
  materials.loss_quantity AS lossQuantity,
  materials.deviation_status AS deviationStatus
FROM production_material_lines AS materials`;

const REPORT_COLUMNS = `SELECT
  reports.execution_order_id AS executionOrderId,
  reports.actual_finished_quantity AS actualFinishedQuantity,
  reports.result
FROM production_reports AS reports`;

const COMPONENT_COLUMNS = `SELECT
  components.id,
  components.component_sku AS componentSku
FROM bom_components AS components`;

type ProductionAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles" | "userId"
>;
type DataRow = Record<string, unknown>;
interface ProductionOrderRow extends Omit<
  ProductionOrder,
  "bom" | "factory" | "item" | "materials" | "purchaseOrder" | "reports"
> {
  bomId: number | null;
  factoryId: number;
  orderItemId: number;
}
interface ProductionOrderItemRow {
  id: number;
  itemType: "finished" | "auxiliary" | "component";
  productName: string;
  purchaseOrderId: number;
  quantity: number;
  sku: string;
}
interface ProductionFactoryRow extends ProductionFactory {
  status: string;
}
interface ProductionBomRow extends ProductionBom {
  active: boolean;
  approvalStatus: "draft" | "pending" | "approved" | "rejected";
}
interface ProductionMaterialLineRow extends ProductionMaterialLine {
  bomComponentId: number;
  executionOrderId: number;
}
interface ProductionReportRow extends ProductionReport {
  executionOrderId: number;
}
type ProductionScope =
  | { kind: "internal" }
  | { kind: "factory"; factoryId: number };

export interface ProductionOrdersAuditEvent {
  access: ProductionAccessContext;
  action: "view";
  module: "production";
  entityType: "execution_order_list";
  entityId: "latest";
  request: FastifyRequest;
}

export interface ProductionOrdersModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<ProductionAccessContext>;
  database?: QueryExecutor;
  audit?: (event: ProductionOrdersAuditEvent) => Promise<void>;
}

export class ProductionOrdersForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Production orders access forbidden");
    this.name = "ProductionOrdersForbiddenError";
  }
}

export class ProductionOrdersUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Production orders unavailable");
    this.name = "ProductionOrdersUnavailableError";
  }
}

function invalidData(): never {
  throw new ProductionOrdersUnavailableError();
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

function order(row: DataRow): ProductionOrderRow {
  return {
    id: positiveInteger(row.id),
    executionNo: string(row.executionNo),
    orderItemId: positiveInteger(row.orderItemId),
    factoryId: positiveInteger(row.factoryId),
    bomId: nullablePositiveInteger(row.bomId),
    plannedQuantity: positiveInteger(row.plannedQuantity),
    completedQuantity: nonNegativeInteger(row.completedQuantity),
    status: string(row.status),
    plannedStartDate: nullableString(row.plannedStartDate),
    plannedFinishDate: nullableString(row.plannedFinishDate),
  };
}

function orderItem(row: DataRow): ProductionOrderItemRow {
  return {
    id: positiveInteger(row.id),
    purchaseOrderId: positiveInteger(row.purchaseOrderId),
    sku: string(row.sku),
    productName: string(row.productName),
    itemType: enumeration(row.itemType, [
      "finished",
      "auxiliary",
      "component",
    ] as const),
    quantity: positiveInteger(row.quantity),
  };
}

function purchaseOrder(row: DataRow): ProductionPurchaseOrder {
  return {
    id: positiveInteger(row.id),
    orderNo: string(row.orderNo),
  };
}

function factory(row: DataRow): ProductionFactoryRow {
  return {
    id: positiveInteger(row.id),
    name: string(row.name),
    status: string(row.status),
  };
}

function bom(row: DataRow): ProductionBomRow {
  return {
    id: positiveInteger(row.id),
    finishedSku: string(row.finishedSku),
    version: string(row.version),
    approvalStatus: enumeration(row.approvalStatus, [
      "draft",
      "pending",
      "approved",
      "rejected",
    ] as const),
    active: boolean(row.active),
  };
}

function material(row: DataRow): ProductionMaterialLineRow {
  return {
    id: positiveInteger(row.id),
    executionOrderId: positiveInteger(row.executionOrderId),
    bomComponentId: positiveInteger(row.bomComponentId),
    theoreticalQuantity: positiveInteger(row.theoreticalQuantity),
    issuedQuantity: nonNegativeInteger(row.issuedQuantity),
    consumedQuantity: nonNegativeInteger(row.consumedQuantity),
    lossQuantity: nonNegativeInteger(row.lossQuantity),
    deviationStatus: enumeration(row.deviationStatus, [
      "within_tolerance",
      "pending_approval",
      "approved",
      "rejected",
    ] as const),
  };
}

function component(row: DataRow): ProductionBomComponent {
  return {
    id: positiveInteger(row.id),
    componentSku: string(row.componentSku),
  };
}

function report(row: DataRow): ProductionReportRow {
  return {
    executionOrderId: positiveInteger(row.executionOrderId),
    actualFinishedQuantity: nonNegativeInteger(row.actualFinishedQuantity),
    result: enumeration(row.result, [
      "within_tolerance",
      "overproduction_quarantined",
      "underproduction_pending",
      "approved",
      "rejected_factory_owned",
    ] as const),
  };
}

function resolveScope(context: ProductionAccessContext): ProductionScope {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new ProductionOrdersForbiddenError();
  }
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) {
    return { kind: "internal" };
  }
  if (
    context.roles.includes("factory") &&
    context.factoryId !== null &&
    Number.isSafeInteger(context.factoryId) &&
    context.factoryId > 0
  ) {
    return { kind: "factory", factoryId: context.factoryId };
  }
  throw new ProductionOrdersForbiddenError();
}

function placeholders(count: number, maximum: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximum) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

async function boundedQuery<Value>(
  database: QueryExecutor,
  sql: string,
  params: QueryParameters,
  maximum: number,
  parse: (row: DataRow) => Value,
): Promise<Value[]> {
  const rows = await database.query<DataRow>(sql, params);
  if (rows.length > maximum) return invalidData();
  return rows.map(parse);
}

async function relatedRows<Value>(
  database: QueryExecutor,
  sql: string,
  ids: readonly number[],
  maximum: number,
  parse: (row: DataRow) => Value,
): Promise<Value[]> {
  if (ids.length === 0) return [];
  return boundedQuery(database, sql, ids, maximum, parse);
}

function ensureClosed<Value>(
  rows: readonly Value[],
  ids: ReadonlySet<number>,
  parentId: (row: Value) => number,
): void {
  if (rows.some((row) => !ids.has(parentId(row)))) invalidData();
}

async function readProductionOrders(
  database: QueryExecutor,
  scope: ProductionScope,
): Promise<ProductionOrdersResponse> {
  const orderSql =
    scope.kind === "internal"
      ? `${ORDER_COLUMNS}
ORDER BY orders.created_at DESC, orders.id DESC
LIMIT ${ORDER_LIMIT}`
      : `${ORDER_COLUMNS}
WHERE orders.factory_id = ?
ORDER BY orders.created_at DESC, orders.id DESC
LIMIT ${ORDER_LIMIT}`;
  const orderRows = await database.query<DataRow>(
    orderSql,
    scope.kind === "factory" ? [scope.factoryId] : [],
  );
  if (orderRows.length > ORDER_LIMIT) return invalidData();
  const orders = orderRows.map(order);
  if (
    scope.kind === "factory" &&
    orders.some((row) => row.factoryId !== scope.factoryId)
  ) {
    return invalidData();
  }
  const requiredItemIds = Array.from(
    new Set(orders.map((row) => row.orderItemId)),
  );
  const requiredFactoryIds = Array.from(
    new Set([
      ...orders.map((row) => row.factoryId),
      ...(scope.kind === "factory" ? [scope.factoryId] : []),
    ]),
  );
  const requiredBomIds = Array.from(
    new Set(
      orders.flatMap((row) => (row.bomId === null ? [] : [row.bomId])),
    ),
  );

  const requiredItemPromise = relatedRows(
    database,
    requiredItemIds.length === 0
      ? ""
      : `${ITEM_COLUMNS}
WHERE items.id IN (${placeholders(requiredItemIds.length, ORDER_LIMIT)})
ORDER BY items.id ASC
LIMIT ${requiredItemIds.length}`,
    requiredItemIds,
    requiredItemIds.length,
    orderItem,
  );
  const optionItemPromise = boundedQuery(
    database,
    scope.kind === "factory"
      ? `${FACTORY_OPTION_ITEM_COLUMNS}
WHERE items.item_type = ?
  AND plan_items.factory_id = ?
  AND NOT EXISTS (
    SELECT 1
    FROM execution_orders AS used_orders
    WHERE used_orders.order_item_id = items.id
  )
GROUP BY
  items.id,
  items.purchase_order_id,
  items.sku,
  items.product_name,
  items.item_type
ORDER BY items.id ASC
LIMIT ${ITEM_LIMIT}`
      : `${ITEM_COLUMNS}
WHERE items.item_type = ?
  AND NOT EXISTS (
    SELECT 1
    FROM execution_orders AS used_orders
    WHERE used_orders.order_item_id = items.id
  )
ORDER BY items.id ASC
LIMIT ${ITEM_LIMIT}`,
    scope.kind === "factory" ? ["finished", scope.factoryId] : ["finished"],
    ITEM_LIMIT,
    orderItem,
  );
  const requiredFactoryPromise = relatedRows(
    database,
    requiredFactoryIds.length === 0
      ? ""
      : `${FACTORY_COLUMNS}
WHERE factories.id IN (${placeholders(requiredFactoryIds.length, ORDER_LIMIT)})
ORDER BY factories.id ASC
LIMIT ${requiredFactoryIds.length}`,
    requiredFactoryIds,
    requiredFactoryIds.length,
    factory,
  );
  const optionFactoryPromise =
    scope.kind === "factory"
      ? Promise.resolve<ProductionFactoryRow[]>([])
      : boundedQuery(
          database,
          `${FACTORY_COLUMNS}
WHERE factories.status = ?
ORDER BY factories.id ASC
LIMIT ${FACTORY_LIMIT}`,
          ["active"],
          FACTORY_LIMIT,
          factory,
        );
  const requiredBomPromise = relatedRows(
    database,
    requiredBomIds.length === 0
      ? ""
      : `${BOM_COLUMNS}
WHERE boms.id IN (${placeholders(requiredBomIds.length, ORDER_LIMIT)})
ORDER BY boms.id ASC
LIMIT ${requiredBomIds.length}`,
    requiredBomIds,
    requiredBomIds.length,
    bom,
  );
  const optionBomPromise = boundedQuery(
    database,
    `${BOM_COLUMNS}
WHERE boms.approval_status = ? AND boms.active = ?
ORDER BY boms.id ASC
LIMIT ${BOM_LIMIT}`,
    ["approved", 1],
    BOM_LIMIT,
    bom,
  );
  const [
    requiredItems,
    optionItems,
    requiredFactories,
    optionFactories,
    requiredBoms,
    optionBoms,
  ] = await Promise.all([
    requiredItemPromise,
    optionItemPromise,
    requiredFactoryPromise,
    optionFactoryPromise,
    requiredBomPromise,
    optionBomPromise,
  ]);
  ensureClosed(requiredItems, new Set(requiredItemIds), (row) => row.id);
  ensureClosed(requiredFactories, new Set(requiredFactoryIds), (row) => row.id);
  ensureClosed(requiredBoms, new Set(requiredBomIds), (row) => row.id);
  if (
    optionItems.some((row) => row.itemType !== "finished") ||
    optionFactories.some((row) => row.status !== "active") ||
    optionBoms.some(
      (row) => row.approvalStatus !== "approved" || !row.active,
    )
  ) {
    return invalidData();
  }

  const purchaseIds = Array.from(
    new Set(
      [...requiredItems, ...optionItems].map((item) => item.purchaseOrderId),
    ),
  );
  const purchases = await relatedRows(
    database,
    purchaseIds.length === 0
      ? ""
      : `${PURCHASE_ORDER_COLUMNS}
WHERE purchases.id IN (${placeholders(purchaseIds.length, PURCHASE_ORDER_LIMIT)})
ORDER BY purchases.id ASC
LIMIT ${PURCHASE_ORDER_LIMIT}`,
    purchaseIds,
    PURCHASE_ORDER_LIMIT,
    purchaseOrder,
  );
  const purchaseIdSet = new Set(purchaseIds);
  if (purchases.some((row) => !purchaseIdSet.has(row.id))) {
    return invalidData();
  }

  const orderIds = orders.map((row) => row.id);
  const materials = await relatedRows(
    database,
    orderIds.length === 0
      ? ""
      : `${MATERIAL_COLUMNS}
WHERE materials.execution_order_id IN (${placeholders(orderIds.length, ORDER_LIMIT)})
ORDER BY materials.execution_order_id ASC, materials.id ASC
LIMIT ${MATERIAL_LIMIT + 1}`,
    orderIds,
    MATERIAL_LIMIT,
    material,
  );
  const reports = await relatedRows(
    database,
    orderIds.length === 0
      ? ""
      : `${REPORT_COLUMNS}
WHERE reports.execution_order_id IN (${placeholders(orderIds.length, ORDER_LIMIT)})
ORDER BY reports.execution_order_id ASC, reports.id DESC
LIMIT ${REPORT_LIMIT + 1}`,
    orderIds,
    REPORT_LIMIT,
    report,
  );
  const orderIdSet = new Set(orderIds);
  ensureClosed(materials, orderIdSet, (row) => row.executionOrderId);
  ensureClosed(reports, orderIdSet, (row) => row.executionOrderId);

  const componentIds = Array.from(
    new Set(materials.map((row) => row.bomComponentId)),
  );
  const components = await relatedRows(
    database,
    componentIds.length === 0
      ? ""
      : `${COMPONENT_COLUMNS}
WHERE components.id IN (${placeholders(componentIds.length, COMPONENT_LIMIT)})
ORDER BY components.id ASC
LIMIT ${COMPONENT_LIMIT + 1}`,
    componentIds,
    COMPONENT_LIMIT,
    component,
  );
  const componentIdSet = new Set(componentIds);
  if (components.some((row) => !componentIdSet.has(row.id))) invalidData();

  const itemById = new Map(
    [...optionItems, ...requiredItems].map((row) => [row.id, row]),
  );
  const purchaseById = new Map(purchases.map((row) => [row.id, row]));
  const factoryById = new Map(
    [...optionFactories, ...requiredFactories].map((row) => [row.id, row]),
  );
  const bomById = new Map(
    [...optionBoms, ...requiredBoms].map((row) => [row.id, row]),
  );
  const componentById = new Map(components.map((row) => [row.id, row]));

  const enrichedOrders: ProductionOrder[] = orders.map((value) => {
    const item = itemById.get(value.orderItemId);
    const purchase = item
      ? purchaseById.get(item.purchaseOrderId)
      : undefined;
    const factoryValue = factoryById.get(value.factoryId);
    const bomValue = value.bomId === null ? undefined : bomById.get(value.bomId);
    return {
      id: value.id,
      executionNo: value.executionNo,
      plannedQuantity: value.plannedQuantity,
      completedQuantity: value.completedQuantity,
      status: value.status,
      plannedStartDate: value.plannedStartDate,
      plannedFinishDate: value.plannedFinishDate,
      ...(item === undefined
        ? {}
        : {
            item: {
              id: item.id,
              sku: item.sku,
              productName: item.productName,
            },
          }),
      ...(purchase === undefined ? {} : { purchaseOrder: purchase }),
      ...(factoryValue === undefined
        ? {}
        : { factory: { id: factoryValue.id, name: factoryValue.name } }),
      ...(bomValue === undefined
        ? {}
        : {
            bom: {
              id: bomValue.id,
              finishedSku: bomValue.finishedSku,
              version: bomValue.version,
            },
          }),
      materials: materials
        .filter((row) => row.executionOrderId === value.id)
        .map((row) => {
          const componentValue = componentById.get(row.bomComponentId);
          return {
            id: row.id,
            theoreticalQuantity: row.theoreticalQuantity,
            issuedQuantity: row.issuedQuantity,
            consumedQuantity: row.consumedQuantity,
            lossQuantity: row.lossQuantity,
            deviationStatus: row.deviationStatus,
            ...(componentValue === undefined
              ? {}
              : { component: componentValue }),
          };
        }),
      reports: reports
        .filter((row) => row.executionOrderId === value.id)
        .map((row) => ({
          actualFinishedQuantity: row.actualFinishedQuantity,
          result: row.result,
        })),
    };
  });

  const orderItems: ProductionOrderOption[] = optionItems.map((item) => {
    const purchase = purchaseById.get(item.purchaseOrderId);
    return {
      id: item.id,
      sku: item.sku,
      productName: item.productName,
      quantity: item.quantity,
      ...(purchase === undefined ? {} : { purchaseOrder: purchase }),
    };
  });

  const publicFactories = (
    scope.kind === "factory"
      ? requiredFactories.filter((row) => row.id === scope.factoryId)
      : optionFactories
  ).map((row) => ({ id: row.id, name: row.name }));
  const publicBoms = optionBoms.map((row) => ({
    id: row.id,
    finishedSku: row.finishedSku,
    version: row.version,
  }));

  return {
    orders: enrichedOrders,
    options: {
      orderItems,
      factories: publicFactories,
      boms: publicBoms,
    },
  };
}

export async function registerProductionOrdersModule(
  app: FastifyInstance,
  options: ProductionOrdersModuleOptions,
): Promise<void> {
  if (!app.getSchema(productionOrdersSchemaId)) {
    app.addSchema(productionOrdersResponseSchema);
  }

  app.get<{ Reply: ProductionOrdersResponse }>(
    "/api/v1/production-orders",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["production-orders"],
        summary: "Read production orders",
        response: {
          200: { $ref: `${productionOrdersSchemaId}#` },
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
      if (access.localPreview) {
        return {
          orders: [],
          options: { orderItems: [], factories: [], boms: [] },
          preview: true,
        };
      }
      if (options.database === undefined || options.audit === undefined) {
        throw new ProductionOrdersUnavailableError();
      }
      const response = await readProductionOrders(options.database, scope);
      try {
        await options.audit({
          access,
          action: "view",
          module: "production",
          entityType: "execution_order_list",
          entityId: "latest",
          request,
        });
      } catch {
        throw new ProductionOrdersUnavailableError();
      }
      return response;
    },
  );
}
