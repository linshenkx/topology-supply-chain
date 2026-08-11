export const returnsSchemaId = "Returns";

export interface DeliveryBatch {
  id: number;
  executionOrderId: number;
  batchNo: string;
  quantity: number;
  plannedShipAt: string;
  shippedAt: string | null;
  carrier: string;
  logisticsNo: string;
  destination: string;
  requiresApproval: boolean;
  deviationReason: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductReturnInspection {
  id: number;
  productReturnId: number;
  inspectedQuantity: number;
  passedQuantity: number;
  failedQuantity: number;
  defectReason: string;
  evidenceFileKey: string;
  inspectedBy: number;
  inspectedAt: string;
}

export interface ProductReturnDisposition {
  id: number;
  productReturnId: number;
  type: "restock" | "rework" | "scrap";
  quantity: number;
  proposedBy: number;
  status: "pending_supply_chain" | "approved" | "rejected";
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductReturn {
  id: number;
  returnNo: string;
  sourceDeliveryBatchId: number;
  warehouseId: number;
  sku: string;
  quantity: number;
  batchId: number | null;
  status:
    | "return_in_transit"
    | "quarantined"
    | "inspection"
    | "pending_supply_chain"
    | "restocked"
    | "rework"
    | "scrapped";
  proposedDisposition: "restock" | "rework" | "scrap" | null;
  proposedBy: number | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sourceShipment: DeliveryBatch | null;
  inspections: ProductReturnInspection[];
  dispositions: ProductReturnDisposition[];
}

export interface ReturnsResponse {
  returns: ProductReturn[];
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = {
  anyOf: [{ type: "null" }, positiveInteger],
} as const;
const nullableString = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

const deliveryBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "executionOrderId",
    "batchNo",
    "quantity",
    "plannedShipAt",
    "shippedAt",
    "carrier",
    "logisticsNo",
    "destination",
    "requiresApproval",
    "deviationReason",
    "status",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    executionOrderId: positiveInteger,
    batchNo: { type: "string", minLength: 1 },
    quantity: positiveInteger,
    plannedShipAt: { type: "string", minLength: 1 },
    shippedAt: nullableString,
    carrier: { type: "string" },
    logisticsNo: { type: "string" },
    destination: { type: "string" },
    requiresApproval: { type: "boolean" },
    deviationReason: nullableString,
    status: { type: "string", minLength: 1 },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
} as const;

const inspectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "productReturnId",
    "inspectedQuantity",
    "passedQuantity",
    "failedQuantity",
    "defectReason",
    "evidenceFileKey",
    "inspectedBy",
    "inspectedAt",
  ],
  properties: {
    id: positiveInteger,
    productReturnId: positiveInteger,
    inspectedQuantity: positiveInteger,
    passedQuantity: nonNegativeInteger,
    failedQuantity: nonNegativeInteger,
    defectReason: { type: "string" },
    evidenceFileKey: { type: "string", minLength: 1 },
    inspectedBy: positiveInteger,
    inspectedAt: { type: "string", minLength: 1 },
  },
} as const;

const dispositionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "productReturnId",
    "type",
    "quantity",
    "proposedBy",
    "status",
    "reviewedBy",
    "reviewedAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: positiveInteger,
    productReturnId: positiveInteger,
    type: { type: "string", enum: ["restock", "rework", "scrap"] },
    quantity: nonNegativeInteger,
    proposedBy: positiveInteger,
    status: {
      type: "string",
      enum: ["pending_supply_chain", "approved", "rejected"],
    },
    reviewedBy: nullablePositiveInteger,
    reviewedAt: nullableString,
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
} as const;

export const returnsResponseSchema = {
  $id: returnsSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["returns"],
  properties: {
    returns: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "returnNo",
          "sourceDeliveryBatchId",
          "warehouseId",
          "sku",
          "quantity",
          "batchId",
          "status",
          "proposedDisposition",
          "proposedBy",
          "reviewedBy",
          "reviewedAt",
          "createdAt",
          "updatedAt",
          "sourceShipment",
          "inspections",
          "dispositions",
        ],
        properties: {
          id: positiveInteger,
          returnNo: { type: "string", minLength: 1 },
          sourceDeliveryBatchId: positiveInteger,
          warehouseId: positiveInteger,
          sku: { type: "string", minLength: 1 },
          quantity: positiveInteger,
          batchId: nullablePositiveInteger,
          status: {
            type: "string",
            enum: [
              "return_in_transit",
              "quarantined",
              "inspection",
              "pending_supply_chain",
              "restocked",
              "rework",
              "scrapped",
            ],
          },
          proposedDisposition: {
            anyOf: [
              { type: "null" },
              { type: "string", enum: ["restock", "rework", "scrap"] },
            ],
          },
          proposedBy: nullablePositiveInteger,
          reviewedBy: nullablePositiveInteger,
          reviewedAt: nullableString,
          createdAt: { type: "string", minLength: 1 },
          updatedAt: { type: "string", minLength: 1 },
          sourceShipment: {
            anyOf: [{ type: "null" }, deliveryBatchSchema],
          },
          inspections: {
            type: "array",
            maxItems: 1_000,
            items: inspectionSchema,
          },
          dispositions: {
            type: "array",
            maxItems: 600,
            items: dispositionSchema,
          },
        },
      },
    },
    preview: { const: true },
  },
} as const;
