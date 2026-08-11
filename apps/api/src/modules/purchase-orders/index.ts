import {
  apiErrorSchemaId,
  purchaseOrdersResponseSchema,
  purchaseOrdersSchemaId,
  type PurchaseOrder,
  type PurchaseOrderItem,
  type PurchaseOrderPlanItem,
  type PurchaseOrderPlanLink,
  type PurchaseOrdersResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set(["admin", "supply_chain"]);
const FACTORY_ROLE = "factory";
const ORDER_LIMIT = 200;
const ITEM_LIMIT = 2_000;
const LINK_LIMIT = 4_000;

const ORDER_COLUMNS = `SELECT
  id,
  order_no AS orderNo,
  source,
  source_file_key AS sourceFileKey,
  status,
  order_date AS orderDate,
  total_tax_included_minor AS totalTaxIncludedMinor,
  payment_term_id AS paymentTermId,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM purchase_orders`;

const ITEM_COLUMNS = `SELECT
  id,
  purchase_order_id AS purchaseOrderId,
  sku,
  product_name AS productName,
  item_type AS itemType,
  supplier_id AS supplierId,
  quantity,
  unit_price_tax_included_minor AS unitPriceTaxIncludedMinor,
  amount_tax_included_minor AS amountTaxIncludedMinor,
  due_date AS dueDate,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM order_items`;

const LINK_COLUMNS = `SELECT
  links.id,
  links.purchase_plan_item_id AS purchasePlanItemId,
  links.order_item_id AS orderItemId,
  links.allocated_quantity AS allocatedQuantity,
  links.match_method AS matchMethod,
  links.confirmed_by AS confirmedBy,
  links.created_at AS createdAt,
  links.updated_at AS updatedAt
FROM purchase_plan_order_links AS links`;

const PLAN_ITEM_COLUMNS = `SELECT
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

type PurchaseOrdersAccessContext = Pick<
  AccessContext,
  "factoryId" | "localPreview" | "roles"
>;
type DataRow = Record<string, unknown>;

export interface PurchaseOrdersModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<PurchaseOrdersAccessContext>;
  database?: QueryExecutor;
}

export class PurchaseOrdersForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Purchase order access forbidden");
    this.name = "PurchaseOrdersForbiddenError";
  }
}

export class PurchaseOrdersUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Purchase orders unavailable");
    this.name = "PurchaseOrdersUnavailableError";
  }
}

function invalidData(): never {
  throw new PurchaseOrdersUnavailableError();
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

function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function resolveFactoryScope(
  context: PurchaseOrdersAccessContext,
): number | null {
  if (context.roles.some((role) => INTERNAL_ROLES.has(role))) return null;
  if (context.roles.includes(FACTORY_ROLE)) {
    if (
      context.factoryId === null ||
      !Number.isSafeInteger(context.factoryId) ||
      context.factoryId <= 0
    ) {
      throw new PurchaseOrdersForbiddenError();
    }
    return context.factoryId;
  }
  throw new PurchaseOrdersForbiddenError();
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) return invalidData();
  return value;
}

function safeMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) return invalidData();
  return value;
}

function order(row: DataRow): Omit<PurchaseOrder, "confirmationDueAt" | "items"> {
  return {
    id: positiveInteger(row.id),
    orderNo: string(row.orderNo),
    source: string(row.source),
    sourceFileKey: nullableString(row.sourceFileKey),
    status: string(row.status),
    orderDate: nullableString(row.orderDate),
    totalTaxIncludedMinor: nonNegativeInteger(row.totalTaxIncludedMinor),
    paymentTermId: nullablePositiveInteger(row.paymentTermId),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function orderItem(row: DataRow): Omit<PurchaseOrderItem, "planLinks"> {
  return {
    id: positiveInteger(row.id),
    purchaseOrderId: positiveInteger(row.purchaseOrderId),
    sku: string(row.sku),
    productName: string(row.productName),
    itemType: enumeration(row.itemType, [
      "finished",
      "auxiliary",
      "component",
    ]),
    supplierId: nullablePositiveInteger(row.supplierId),
    quantity: positiveInteger(row.quantity),
    unitPriceTaxIncludedMinor: nonNegativeInteger(
      row.unitPriceTaxIncludedMinor,
    ),
    amountTaxIncludedMinor: nonNegativeInteger(row.amountTaxIncludedMinor),
    dueDate: nullableString(row.dueDate),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function planLink(
  row: DataRow,
): Omit<PurchaseOrderPlanLink, "planItem"> {
  return {
    id: positiveInteger(row.id),
    purchasePlanItemId: positiveInteger(row.purchasePlanItemId),
    orderItemId: positiveInteger(row.orderItemId),
    allocatedQuantity: positiveInteger(row.allocatedQuantity),
    matchMethod: enumeration(row.matchMethod, ["automatic", "manual"]),
    confirmedBy: positiveInteger(row.confirmedBy),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function purchasePlanItem(row: DataRow): PurchaseOrderPlanItem {
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
    completionStatus: enumeration(row.completionStatus, [
      "not_ordered",
      "within_tolerance",
      "over_plan_pending",
      "under_plan_pending",
      "exception_approved",
    ]),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function uniqueIds(values: readonly number[]): number[] {
  return [...new Set(values)];
}

async function readReminders(
  database: QueryExecutor,
  orderIds: readonly number[],
): Promise<Map<number, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await database.query<DataRow>(
    `SELECT entityId, dueAt
FROM (
  SELECT
    entity_id AS entityId,
    due_at AS dueAt,
    ROW_NUMBER() OVER (
      PARTITION BY entity_id
      ORDER BY created_at DESC, id DESC
    ) AS reminderRank
  FROM reminder_schedules
  WHERE entity_type = ?
    AND reminder_type = ?
    AND status = ?
    AND entity_id IN (${placeholders(orderIds.length, ORDER_LIMIT)})
) AS ranked_reminders
WHERE reminderRank = 1
ORDER BY entityId ASC
LIMIT ${ORDER_LIMIT + 1}`,
    [
      "purchase_order",
      "purchase_order_confirmation",
      "active",
      ...orderIds,
    ],
  );
  ensureBoundedRows(rows, ORDER_LIMIT);
  const allowedOrders = new Set(orderIds);
  const reminders = new Map<number, string>();
  for (const row of rows) {
    const orderId = positiveInteger(row.entityId);
    if (!allowedOrders.has(orderId) || reminders.has(orderId)) {
      return invalidData();
    }
    reminders.set(orderId, string(row.dueAt));
  }
  return reminders;
}

async function readPurchaseOrders(
  database: QueryExecutor,
  factoryId: number | null,
): Promise<PurchaseOrder[]> {
  const orderRows = await database.query<DataRow>(
    `${ORDER_COLUMNS}${
      factoryId === null
        ? ""
        : `
WHERE EXISTS (
  SELECT 1
  FROM order_items AS authorized_items
  INNER JOIN purchase_plan_order_links AS authorized_links
    ON authorized_links.order_item_id = authorized_items.id
  INNER JOIN purchase_plan_items AS authorized_plan_items
    ON authorized_plan_items.id = authorized_links.purchase_plan_item_id
  WHERE authorized_items.purchase_order_id = purchase_orders.id
    AND authorized_plan_items.factory_id = ?
)`
    }
ORDER BY created_at DESC, id DESC
LIMIT ${ORDER_LIMIT}`,
    factoryId === null ? [] : [factoryId],
  );
  const orderIdsSeen = new Set<number>();
  const orders = ensureBoundedRows(orderRows, ORDER_LIMIT).map((row) => {
    const value = order(row);
    if (orderIdsSeen.has(value.id)) return invalidData();
    orderIdsSeen.add(value.id);
    return value;
  });
  const orderIds = orders.map((value) => value.id);
  if (orderIds.length === 0) return [];

  const itemRows = await database.query<DataRow>(
    `${ITEM_COLUMNS}
WHERE purchase_order_id IN (${placeholders(orderIds.length, ORDER_LIMIT)})${
      factoryId === null
        ? ""
        : `
  AND EXISTS (
    SELECT 1
    FROM purchase_plan_order_links AS scoped_links
    INNER JOIN purchase_plan_items AS scoped_items
      ON scoped_items.id = scoped_links.purchase_plan_item_id
    WHERE scoped_links.order_item_id = order_items.id
      AND scoped_items.factory_id = ?
  )`
    }
ORDER BY purchase_order_id ASC, id ASC
LIMIT ${ITEM_LIMIT + 1}`,
    factoryId === null ? orderIds : [...orderIds, factoryId],
  );
  const allowedOrders = new Set(orderIds);
  const itemIds = new Set<number>();
  const items = ensureBoundedRows(itemRows, ITEM_LIMIT).map((row) => {
    const value = orderItem(row);
    if (!allowedOrders.has(value.purchaseOrderId) || itemIds.has(value.id)) {
      return invalidData();
    }
    itemIds.add(value.id);
    return value;
  });

  let links: Array<Omit<PurchaseOrderPlanLink, "planItem">> = [];
  let planItems: PurchaseOrderPlanItem[] = [];
  if (items.length > 0) {
    const selectedItemIds = items.map((item) => item.id);
    const linkRows = await database.query<DataRow>(
      `${LINK_COLUMNS}${
        factoryId === null
          ? ""
          : `
INNER JOIN purchase_plan_items AS scoped_items
  ON scoped_items.id = links.purchase_plan_item_id`
      }
WHERE links.order_item_id IN (${placeholders(
        selectedItemIds.length,
        ITEM_LIMIT,
      )})${factoryId === null ? "" : "\n  AND scoped_items.factory_id = ?"}
ORDER BY links.order_item_id ASC, links.id ASC
LIMIT ${LINK_LIMIT + 1}`,
      factoryId === null
        ? selectedItemIds
        : [...selectedItemIds, factoryId],
    );
    const allowedItems = new Set(selectedItemIds);
    const linkIds = new Set<number>();
    links = ensureBoundedRows(linkRows, LINK_LIMIT).map((row) => {
      const value = planLink(row);
      if (!allowedItems.has(value.orderItemId) || linkIds.has(value.id)) {
        return invalidData();
      }
      linkIds.add(value.id);
      return value;
    });

    const planItemIds = uniqueIds(
      links.map((link) => link.purchasePlanItemId),
    );
    if (planItemIds.length > 0) {
      const planItemRows = await database.query<DataRow>(
        `${PLAN_ITEM_COLUMNS}
WHERE id IN (${placeholders(planItemIds.length, LINK_LIMIT)})
ORDER BY id ASC
LIMIT ${planItemIds.length + 1}`,
        planItemIds,
      );
      ensureBoundedRows(planItemRows, planItemIds.length);
      const allowedPlanItems = new Set(planItemIds);
      const seenPlanItems = new Set<number>();
      planItems = planItemRows.map((row) => {
        const value = purchasePlanItem(row);
        if (
          !allowedPlanItems.has(value.id) ||
          seenPlanItems.has(value.id) ||
          (factoryId !== null && value.factoryId !== factoryId)
        ) {
          return invalidData();
        }
        seenPlanItems.add(value.id);
        return value;
      });
      if (seenPlanItems.size !== planItemIds.length) return invalidData();
    }
  }

  const reminders = await readReminders(database, orderIds);
  const planItemById = new Map(planItems.map((item) => [item.id, item]));
  const linksByItem = new Map<number, PurchaseOrderPlanLink[]>();
  for (const link of links) {
    const linkedPlanItem = planItemById.get(link.purchasePlanItemId);
    if (linkedPlanItem === undefined) return invalidData();
    linksByItem.set(link.orderItemId, [
      ...(linksByItem.get(link.orderItemId) ?? []),
      { ...link, planItem: linkedPlanItem },
    ]);
  }

  const itemsByOrder = new Map<number, PurchaseOrderItem[]>();
  for (const item of items) {
    const itemLinks = linksByItem.get(item.id) ?? [];
    if (factoryId !== null && itemLinks.length === 0) continue;
    const visibleQuantity =
      factoryId === null
        ? item.quantity
        : itemLinks.reduce(
            (total, link) => safeAdd(total, link.allocatedQuantity),
            0,
          );
    const visibleAmount =
      factoryId === null
        ? item.amountTaxIncludedMinor
        : safeMultiply(visibleQuantity, item.unitPriceTaxIncludedMinor);
    itemsByOrder.set(item.purchaseOrderId, [
      ...(itemsByOrder.get(item.purchaseOrderId) ?? []),
      {
        ...item,
        quantity: visibleQuantity,
        amountTaxIncludedMinor: visibleAmount,
        planLinks: itemLinks,
      },
    ]);
  }

  return orders.flatMap((value) => {
    const scopedItems = itemsByOrder.get(value.id) ?? [];
    if (factoryId !== null && scopedItems.length === 0) return [];
    return [
      {
        ...value,
        totalTaxIncludedMinor:
          factoryId === null
            ? value.totalTaxIncludedMinor
            : scopedItems.reduce(
                (total, item) =>
                  safeAdd(total, item.amountTaxIncludedMinor),
                0,
              ),
        items: scopedItems,
        confirmationDueAt: reminders.get(value.id) ?? null,
      },
    ];
  });
}

export async function registerPurchaseOrdersModule(
  app: FastifyInstance,
  options: PurchaseOrdersModuleOptions,
): Promise<void> {
  if (!app.getSchema(purchaseOrdersSchemaId)) {
    app.addSchema(purchaseOrdersResponseSchema);
  }

  app.get<{ Reply: PurchaseOrdersResponse }>(
    "/api/v1/purchase-orders",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["purchase-orders"],
        summary: "Read purchase orders with plan allocation links",
        response: {
          200: { $ref: `${purchaseOrdersSchemaId}#` },
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
      if (access.localPreview) return { orders: [], preview: true };
      if (options.database === undefined) {
        throw new PurchaseOrdersUnavailableError();
      }

      try {
        return { orders: await readPurchaseOrders(options.database, factoryId) };
      } catch {
        throw new PurchaseOrdersUnavailableError();
      }
    },
  );
}
