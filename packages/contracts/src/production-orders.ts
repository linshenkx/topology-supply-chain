export const productionOrdersSchemaId = "ProductionOrders";

export interface ProductionOrderItem {
  id: number;
  purchaseOrderId: number;
  sku: string;
  productName: string;
  itemType: "finished" | "auxiliary" | "component";
  supplierId: number | null;
  quantity: number;
  unitPriceTaxIncludedMinor: number;
  amountTaxIncludedMinor: number;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionPurchaseOrder {
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
}

export interface ProductionFactory {
  id: number;
  name: string;
  code: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionBom {
  id: number;
  finishedSku: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  overlapAllowed: boolean;
  overlapReason: string;
  approvalStatus: "draft" | "pending" | "approved" | "rejected";
  reviewedBy: number | null;
  reviewedAt: string | null;
  active: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionBomComponent {
  id: number;
  bomId: number;
  componentSku: string;
  itemType: "auxiliary" | "component";
  isCore: boolean;
  quantityPerFinished: number;
  issueToleranceBps: number;
  consumptionToleranceBps: number;
  lossToleranceBps: number;
}

export interface ProductionMaterialLine {
  id: number;
  executionOrderId: number;
  bomComponentId: number;
  theoreticalQuantity: number;
  reservedQuantity: number;
  issuedQuantity: number;
  consumedQuantity: number;
  lossQuantity: number;
  deviationStatus: "within_tolerance" | "pending_approval" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  component?: ProductionBomComponent;
}

export interface ProductionReport {
  id: number;
  executionOrderId: number;
  actualFinishedQuantity: number;
  varianceQuantity: number;
  varianceRateBps: number;
  result:
    | "within_tolerance"
    | "overproduction_quarantined"
    | "underproduction_pending"
    | "approved"
    | "rejected_factory_owned";
  companyInventoryQuantity: number;
  factoryOwnedQuantity: number;
  reportedBy: number;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionSku {
  id: number;
  code: string;
  name: string;
  itemType: "finished" | "auxiliary" | "component" | null;
  stockUnit: string | null;
  serialTrackingEnabled: boolean;
  overproductionToleranceBps: number;
  purchaseOverToleranceBps: number;
  purchaseUnderToleranceBps: number;
  verificationStatus: "pending" | "approved" | "rejected";
  status: "draft" | "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface ProductionOrder {
  id: number;
  executionNo: string;
  orderItemId: number;
  factoryId: number;
  bomId: number | null;
  plannedQuantity: number;
  completedQuantity: number;
  status: string;
  dueDate: string | null;
  plannedStartDate: string | null;
  plannedFinishDate: string | null;
  actualStartAt: string | null;
  actualFinishAt: string | null;
  createdAt: string;
  updatedAt: string;
  item?: ProductionOrderItem;
  purchaseOrder?: ProductionPurchaseOrder;
  factory?: ProductionFactory;
  bom?: ProductionBom;
  materials: ProductionMaterialLine[];
  reports: ProductionReport[];
}

export interface ProductionOrderOption extends ProductionOrderItem {
  purchaseOrder?: ProductionPurchaseOrder;
}

export interface ProductionOrderOptions {
  orderItems: ProductionOrderOption[];
  factories: ProductionFactory[];
  boms: ProductionBom[];
  skus: ProductionSku[];
}

export interface ProductionOrdersResponse {
  orders: ProductionOrder[];
  options: ProductionOrderOptions;
  preview?: true;
}

const integer = { type: "integer" } as const;
const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = {
  anyOf: [{ type: "null" }, positiveInteger],
} as const;
const nullableString = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;
const timestamp = { type: "string", minLength: 1 } as const;

const orderItemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "purchaseOrderId", "sku", "productName", "itemType",
    "supplierId", "quantity", "unitPriceTaxIncludedMinor",
    "amountTaxIncludedMinor", "dueDate", "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    purchaseOrderId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    productName: { type: "string", minLength: 1 },
    itemType: { type: "string", enum: ["finished", "auxiliary", "component"] },
    supplierId: nullablePositiveInteger,
    quantity: positiveInteger,
    unitPriceTaxIncludedMinor: nonNegativeInteger,
    amountTaxIncludedMinor: nonNegativeInteger,
    dueDate: nullableString,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const purchaseOrderSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "orderNo", "source", "sourceFileKey", "status", "orderDate",
    "totalTaxIncludedMinor", "paymentTermId", "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    orderNo: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    sourceFileKey: nullableString,
    status: { type: "string", minLength: 1 },
    orderDate: nullableString,
    totalTaxIncludedMinor: nonNegativeInteger,
    paymentTermId: nullablePositiveInteger,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const factorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "code", "status", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    name: { type: "string", minLength: 1 },
    code: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const bomSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "finishedSku", "version", "effectiveFrom", "effectiveTo",
    "overlapAllowed", "overlapReason", "approvalStatus", "reviewedBy",
    "reviewedAt", "active", "createdBy", "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    finishedSku: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    effectiveFrom: timestamp,
    effectiveTo: nullableString,
    overlapAllowed: { type: "boolean" },
    overlapReason: { type: "string" },
    approvalStatus: {
      type: "string",
      enum: ["draft", "pending", "approved", "rejected"],
    },
    reviewedBy: nullablePositiveInteger,
    reviewedAt: nullableString,
    active: { type: "boolean" },
    createdBy: positiveInteger,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const componentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "bomId", "componentSku", "itemType", "isCore",
    "quantityPerFinished", "issueToleranceBps", "consumptionToleranceBps",
    "lossToleranceBps",
  ],
  properties: {
    id: positiveInteger,
    bomId: positiveInteger,
    componentSku: { type: "string", minLength: 1 },
    itemType: { type: "string", enum: ["auxiliary", "component"] },
    isCore: { type: "boolean" },
    quantityPerFinished: positiveInteger,
    issueToleranceBps: nonNegativeInteger,
    consumptionToleranceBps: nonNegativeInteger,
    lossToleranceBps: nonNegativeInteger,
  },
} as const;

const materialSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "executionOrderId", "bomComponentId", "theoreticalQuantity",
    "reservedQuantity", "issuedQuantity", "consumedQuantity", "lossQuantity",
    "deviationStatus", "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    executionOrderId: positiveInteger,
    bomComponentId: positiveInteger,
    theoreticalQuantity: positiveInteger,
    reservedQuantity: nonNegativeInteger,
    issuedQuantity: nonNegativeInteger,
    consumedQuantity: nonNegativeInteger,
    lossQuantity: nonNegativeInteger,
    deviationStatus: {
      type: "string",
      enum: ["within_tolerance", "pending_approval", "approved", "rejected"],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    component: componentSchema,
  },
} as const;

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "executionOrderId", "actualFinishedQuantity", "varianceQuantity",
    "varianceRateBps", "result", "companyInventoryQuantity",
    "factoryOwnedQuantity", "reportedBy", "reviewedBy", "reviewedAt",
    "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    executionOrderId: positiveInteger,
    actualFinishedQuantity: nonNegativeInteger,
    varianceQuantity: integer,
    varianceRateBps: nonNegativeInteger,
    result: {
      type: "string",
      enum: [
        "within_tolerance", "overproduction_quarantined",
        "underproduction_pending", "approved", "rejected_factory_owned",
      ],
    },
    companyInventoryQuantity: nonNegativeInteger,
    factoryOwnedQuantity: nonNegativeInteger,
    reportedBy: positiveInteger,
    reviewedBy: nullablePositiveInteger,
    reviewedAt: nullableString,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const skuSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "code", "name", "itemType", "stockUnit",
    "serialTrackingEnabled", "overproductionToleranceBps",
    "purchaseOverToleranceBps", "purchaseUnderToleranceBps",
    "verificationStatus", "status", "createdAt", "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    code: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    itemType: {
      anyOf: [
        { type: "null" },
        { type: "string", enum: ["finished", "auxiliary", "component"] },
      ],
    },
    stockUnit: nullableString,
    serialTrackingEnabled: { type: "boolean" },
    overproductionToleranceBps: nonNegativeInteger,
    purchaseOverToleranceBps: nonNegativeInteger,
    purchaseUnderToleranceBps: nonNegativeInteger,
    verificationStatus: {
      type: "string",
      enum: ["pending", "approved", "rejected"],
    },
    status: { type: "string", enum: ["draft", "active", "inactive"] },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
} as const;

const productionOrderProperties = {
  id: positiveInteger,
  executionNo: { type: "string", minLength: 1 },
  orderItemId: positiveInteger,
  factoryId: positiveInteger,
  bomId: nullablePositiveInteger,
  plannedQuantity: positiveInteger,
  completedQuantity: nonNegativeInteger,
  status: { type: "string", minLength: 1 },
  dueDate: nullableString,
  plannedStartDate: nullableString,
  plannedFinishDate: nullableString,
  actualStartAt: nullableString,
  actualFinishAt: nullableString,
  createdAt: timestamp,
  updatedAt: timestamp,
  item: orderItemSchema,
  purchaseOrder: purchaseOrderSchema,
  factory: factorySchema,
  bom: bomSchema,
  materials: { type: "array", maxItems: 2_000, items: materialSchema },
  reports: { type: "array", maxItems: 1_000, items: reportSchema },
} as const;

const productionOrderRequired = [
  "id", "executionNo", "orderItemId", "factoryId", "bomId",
  "plannedQuantity", "completedQuantity", "status", "dueDate",
  "plannedStartDate", "plannedFinishDate", "actualStartAt", "actualFinishAt",
  "createdAt", "updatedAt", "materials", "reports",
] as const;

export const productionOrdersResponseSchema = {
  $id: productionOrdersSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["orders", "options"],
  properties: {
    orders: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: productionOrderRequired,
        properties: productionOrderProperties,
      },
    },
    options: {
      type: "object",
      additionalProperties: false,
      required: ["orderItems", "factories", "boms", "skus"],
      properties: {
        orderItems: {
          type: "array",
          maxItems: 1_000,
          items: {
            ...orderItemSchema,
            properties: {
              ...orderItemSchema.properties,
              purchaseOrder: purchaseOrderSchema,
            },
          },
        },
        factories: { type: "array", maxItems: 500, items: factorySchema },
        boms: { type: "array", maxItems: 500, items: bomSchema },
        skus: { type: "array", maxItems: 500, items: skuSchema },
      },
    },
    preview: { const: true },
  },
} as const;
