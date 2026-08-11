export const productionOrdersSchemaId = "ProductionOrders";

export interface ProductionOrderItem {
  id: number;
  sku: string;
  productName: string;
}

export interface ProductionPurchaseOrder {
  orderNo: string;
}

export interface ProductionFactory {
  id: number;
  name: string;
}

export interface ProductionBom {
  id: number;
  finishedSku: string;
  version: string;
}

export interface ProductionBomComponent {
  componentSku: string;
  componentName: string | null;
}

export interface ProductionMaterialLine {
  id: number;
  theoreticalQuantity: number;
  issuedQuantity: number;
  consumedQuantity: number;
  lossQuantity: number;
  deviationStatus: "within_tolerance" | "pending_approval" | "approved" | "rejected";
  component?: ProductionBomComponent;
}

export interface ProductionReport {
  actualFinishedQuantity: number;
  result:
    | "within_tolerance"
    | "overproduction_quarantined"
    | "underproduction_pending"
    | "approved"
    | "rejected_factory_owned";
}

export interface ProductionOrder {
  id: number;
  executionNo: string;
  plannedQuantity: number;
  completedQuantity: number;
  status: string;
  plannedStartDate: string | null;
  plannedFinishDate: string | null;
  item?: Omit<ProductionOrderItem, "id">;
  purchaseOrder?: ProductionPurchaseOrder;
  factory?: Pick<ProductionFactory, "name">;
  bom?: Pick<ProductionBom, "version">;
  materials: ProductionMaterialLine[];
  reports: ProductionReport[];
}

export interface ProductionOrderOption extends ProductionOrderItem {
  quantity: number;
  purchaseOrder?: ProductionPurchaseOrder;
}

export interface ProductionOrderOptions {
  orderItems: ProductionOrderOption[];
  factories: ProductionFactory[];
  boms: ProductionBom[];
}

export interface ProductionOrdersResponse {
  orders: ProductionOrder[];
  options: ProductionOrderOptions;
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullableString = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

const orderItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sku", "productName"],
  properties: {
    id: positiveInteger,
    sku: { type: "string", minLength: 1 },
    productName: { type: "string", minLength: 1 },
  },
} as const;

const orderItemSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sku", "productName"],
  properties: {
    sku: { type: "string", minLength: 1 },
    productName: { type: "string", minLength: 1 },
  },
} as const;

const purchaseOrderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["orderNo"],
  properties: {
    orderNo: { type: "string", minLength: 1 },
  },
} as const;

const factorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name"],
  properties: {
    id: positiveInteger,
    name: { type: "string", minLength: 1 },
  },
} as const;

const factorySummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
  },
} as const;

const bomSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "finishedSku", "version"],
  properties: {
    id: positiveInteger,
    finishedSku: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
  },
} as const;

const bomSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { type: "string", minLength: 1 },
  },
} as const;

const componentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["componentSku", "componentName"],
  properties: {
    componentSku: { type: "string", minLength: 1 },
    componentName: nullableString,
  },
} as const;

const materialSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "theoreticalQuantity",
    "issuedQuantity",
    "consumedQuantity",
    "lossQuantity",
    "deviationStatus",
  ],
  properties: {
    id: positiveInteger,
    theoreticalQuantity: positiveInteger,
    issuedQuantity: nonNegativeInteger,
    consumedQuantity: nonNegativeInteger,
    lossQuantity: nonNegativeInteger,
    deviationStatus: {
      type: "string",
      enum: ["within_tolerance", "pending_approval", "approved", "rejected"],
    },
    component: componentSchema,
  },
} as const;

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actualFinishedQuantity", "result"],
  properties: {
    actualFinishedQuantity: nonNegativeInteger,
    result: {
      type: "string",
      enum: [
        "within_tolerance",
        "overproduction_quarantined",
        "underproduction_pending",
        "approved",
        "rejected_factory_owned",
      ],
    },
  },
} as const;

const productionOrderSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "executionNo",
    "plannedQuantity",
    "completedQuantity",
    "status",
    "plannedStartDate",
    "plannedFinishDate",
    "materials",
    "reports",
  ],
  properties: {
    id: positiveInteger,
    executionNo: { type: "string", minLength: 1 },
    plannedQuantity: positiveInteger,
    completedQuantity: nonNegativeInteger,
    status: { type: "string", minLength: 1 },
    plannedStartDate: nullableString,
    plannedFinishDate: nullableString,
    item: orderItemSummarySchema,
    purchaseOrder: purchaseOrderSchema,
    factory: factorySummarySchema,
    bom: bomSummarySchema,
    materials: { type: "array", maxItems: 2_000, items: materialSchema },
    reports: { type: "array", maxItems: 1_000, items: reportSchema },
  },
} as const;

const orderOptionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sku", "productName", "quantity"],
  properties: {
    ...orderItemSchema.properties,
    quantity: positiveInteger,
    purchaseOrder: purchaseOrderSchema,
  },
} as const;

export const productionOrdersResponseSchema = {
  $id: productionOrdersSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["orders", "options"],
  properties: {
    orders: {
      type: "array",
      maxItems: 200,
      items: productionOrderSchema,
    },
    options: {
      type: "object",
      additionalProperties: false,
      required: ["orderItems", "factories", "boms"],
      properties: {
        orderItems: {
          type: "array",
          maxItems: 1_000,
          items: orderOptionSchema,
        },
        factories: { type: "array", maxItems: 500, items: factorySchema },
        boms: { type: "array", maxItems: 500, items: bomSchema },
      },
    },
    preview: { const: true },
  },
} as const;
