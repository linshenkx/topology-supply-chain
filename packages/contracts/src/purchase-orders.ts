export const purchaseOrdersSchemaId = "PurchaseOrders";

export interface PurchaseOrderPlanItem {
  id: number;
  purchasePlanId: number;
  expectedArrivalDate: string;
  factoryId: number;
  warehouseId: number;
  sku: string;
  productName: string;
  bomId: number;
  plannedQuantity: number;
  orderedQuantity: number;
  overToleranceBps: number;
  underToleranceBps: number;
  completionStatus:
    | "not_ordered"
    | "within_tolerance"
    | "over_plan_pending"
    | "under_plan_pending"
    | "exception_approved";
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderPlanLink {
  id: number;
  purchasePlanItemId: number;
  orderItemId: number;
  allocatedQuantity: number;
  matchMethod: "automatic" | "manual";
  confirmedBy: number;
  createdAt: string;
  updatedAt: string;
  planItem: PurchaseOrderPlanItem;
}

export interface PurchaseOrderItem {
  id: number;
  purchaseOrderId: number;
  sku: string;
  productName: string;
  itemType: "finished" | "auxiliary" | "component";
  supplierId: number | null;
  quantity: number;
  receivedQuantity: number;
  unitPriceTaxIncludedMinor: number;
  amountTaxIncludedMinor: number;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  planLinks: PurchaseOrderPlanLink[];
}

export interface PurchaseOrder {
  id: number;
  orderNo: string;
  source: string;
  sourceFileKey: string | null;
  status: string;
  orderDate: string | null;
  totalTaxIncludedMinor: number;
  paymentTermId: number | null;
  createdAt: string;
  updatedAt: string;
  items: PurchaseOrderItem[];
  confirmationDueAt: string | null;
}

export interface PurchaseOrdersResponse {
  orders: PurchaseOrder[];
  preview?: true;
}

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const;
const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const nullableStringSchema = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;
const nullablePositiveIntegerSchema = {
  anyOf: [{ type: "null" }, positiveIntegerSchema],
} as const;

const planItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "purchasePlanId",
    "expectedArrivalDate",
    "factoryId",
    "warehouseId",
    "sku",
    "productName",
    "bomId",
    "plannedQuantity",
    "orderedQuantity",
    "overToleranceBps",
    "underToleranceBps",
    "completionStatus",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: positiveIntegerSchema,
    purchasePlanId: positiveIntegerSchema,
    expectedArrivalDate: nonEmptyStringSchema,
    factoryId: positiveIntegerSchema,
    warehouseId: positiveIntegerSchema,
    sku: nonEmptyStringSchema,
    productName: nonEmptyStringSchema,
    bomId: positiveIntegerSchema,
    plannedQuantity: positiveIntegerSchema,
    orderedQuantity: nonNegativeIntegerSchema,
    overToleranceBps: nonNegativeIntegerSchema,
    underToleranceBps: nonNegativeIntegerSchema,
    completionStatus: {
      type: "string",
      enum: [
        "not_ordered",
        "within_tolerance",
        "over_plan_pending",
        "under_plan_pending",
        "exception_approved",
      ],
    },
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  },
} as const;

const planLinkSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "purchasePlanItemId",
    "orderItemId",
    "allocatedQuantity",
    "matchMethod",
    "confirmedBy",
    "createdAt",
    "updatedAt",
    "planItem",
  ],
  properties: {
    id: positiveIntegerSchema,
    purchasePlanItemId: positiveIntegerSchema,
    orderItemId: positiveIntegerSchema,
    allocatedQuantity: positiveIntegerSchema,
    matchMethod: { type: "string", enum: ["automatic", "manual"] },
    confirmedBy: positiveIntegerSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    planItem: planItemSchema,
  },
} as const;

const orderItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "purchaseOrderId",
    "sku",
    "productName",
    "itemType",
    "supplierId",
    "quantity",
    "receivedQuantity",
    "unitPriceTaxIncludedMinor",
    "amountTaxIncludedMinor",
    "dueDate",
    "createdAt",
    "updatedAt",
    "planLinks",
  ],
  properties: {
    id: positiveIntegerSchema,
    purchaseOrderId: positiveIntegerSchema,
    sku: nonEmptyStringSchema,
    productName: nonEmptyStringSchema,
    itemType: {
      type: "string",
      enum: ["finished", "auxiliary", "component"],
    },
    supplierId: nullablePositiveIntegerSchema,
    quantity: positiveIntegerSchema,
    receivedQuantity: nonNegativeIntegerSchema,
    unitPriceTaxIncludedMinor: nonNegativeIntegerSchema,
    amountTaxIncludedMinor: nonNegativeIntegerSchema,
    dueDate: nullableStringSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    planLinks: {
      type: "array",
      maxItems: 4_000,
      items: planLinkSchema,
    },
  },
} as const;

export const purchaseOrdersResponseSchema = {
  $id: purchaseOrdersSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["orders"],
  properties: {
    orders: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "orderNo",
          "source",
          "sourceFileKey",
          "status",
          "orderDate",
          "totalTaxIncludedMinor",
          "paymentTermId",
          "createdAt",
          "updatedAt",
          "items",
          "confirmationDueAt",
        ],
        properties: {
          id: positiveIntegerSchema,
          orderNo: nonEmptyStringSchema,
          source: nonEmptyStringSchema,
          sourceFileKey: nullableStringSchema,
          status: nonEmptyStringSchema,
          orderDate: nullableStringSchema,
          totalTaxIncludedMinor: nonNegativeIntegerSchema,
          paymentTermId: nullablePositiveIntegerSchema,
          createdAt: nonEmptyStringSchema,
          updatedAt: nonEmptyStringSchema,
          items: {
            type: "array",
            maxItems: 2_000,
            items: orderItemSchema,
          },
          confirmationDueAt: nullableStringSchema,
        },
      },
    },
    preview: { const: true },
  },
} as const;
