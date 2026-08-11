export const shipmentsSchemaId = "Shipments";

export interface ShipmentExecution {
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
}

export interface ShipmentOrderItem {
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

export interface ShipmentEvidence {
  id: number;
  deliveryBatchId: number;
  fileKey: string;
  fileName: string;
  createdAt: string;
}

export interface ShipmentReceipt {
  id: number;
  deliveryBatchId: number;
  receivedQuantity: number;
  damagedQuantity: number;
  receivedAt: string;
  evidenceFileKey: string;
  exceptionReason: string;
  receivedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentException {
  id: number;
  executionOrderId: number;
  factoryId: number | null;
  type: "logistics_exception";
  description: string;
  evidenceFileKey: string | null;
  status: string;
  submittedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface Shipment {
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
  execution: ShipmentExecution;
  item: ShipmentOrderItem;
  evidence: ShipmentEvidence[];
  receipts: ShipmentReceipt[];
  exceptions: ShipmentException[];
}

export interface ShipmentsResponse {
  shipments: Shipment[];
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = { anyOf: [{ type: "null" }, positiveInteger] } as const;
const nullableString = { anyOf: [{ type: "null" }, { type: "string" }] } as const;
const timestamps = { createdAt: { type: "string", minLength: 1 }, updatedAt: { type: "string", minLength: 1 } } as const;

const executionSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "executionNo", "orderItemId", "factoryId", "bomId", "plannedQuantity", "completedQuantity", "status", "dueDate", "plannedStartDate", "plannedFinishDate", "actualStartAt", "actualFinishAt", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger, executionNo: { type: "string", minLength: 1 }, orderItemId: positiveInteger,
    factoryId: positiveInteger, bomId: nullablePositiveInteger, plannedQuantity: positiveInteger,
    completedQuantity: nonNegativeInteger, status: { type: "string", minLength: 1 },
    dueDate: nullableString, plannedStartDate: nullableString, plannedFinishDate: nullableString,
    actualStartAt: nullableString, actualFinishAt: nullableString, ...timestamps,
  },
} as const;

const itemSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "purchaseOrderId", "sku", "productName", "itemType", "supplierId", "quantity", "unitPriceTaxIncludedMinor", "amountTaxIncludedMinor", "dueDate", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger, purchaseOrderId: positiveInteger, sku: { type: "string", minLength: 1 },
    productName: { type: "string", minLength: 1 }, itemType: { type: "string", enum: ["finished", "auxiliary", "component"] },
    supplierId: nullablePositiveInteger, quantity: positiveInteger, unitPriceTaxIncludedMinor: nonNegativeInteger,
    amountTaxIncludedMinor: nonNegativeInteger, dueDate: nullableString, ...timestamps,
  },
} as const;

const evidenceSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "deliveryBatchId", "fileKey", "fileName", "createdAt"],
  properties: {
    id: positiveInteger, deliveryBatchId: positiveInteger, fileKey: { type: "string", minLength: 1 },
    fileName: { type: "string", minLength: 1 }, createdAt: { type: "string", minLength: 1 },
  },
} as const;

const receiptSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "deliveryBatchId", "receivedQuantity", "damagedQuantity", "receivedAt", "evidenceFileKey", "exceptionReason", "receivedBy", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger, deliveryBatchId: positiveInteger, receivedQuantity: nonNegativeInteger,
    damagedQuantity: nonNegativeInteger, receivedAt: { type: "string", minLength: 1 },
    evidenceFileKey: { type: "string", minLength: 1 }, exceptionReason: { type: "string" },
    receivedBy: positiveInteger, ...timestamps,
  },
} as const;

const exceptionSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "executionOrderId", "factoryId", "type", "description", "evidenceFileKey", "status", "submittedBy", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger, executionOrderId: positiveInteger, factoryId: nullablePositiveInteger,
    type: { const: "logistics_exception" }, description: { type: "string", minLength: 1 },
    evidenceFileKey: nullableString, status: { type: "string", minLength: 1 },
    submittedBy: positiveInteger, ...timestamps,
  },
} as const;

const shipmentSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "executionOrderId", "batchNo", "quantity", "plannedShipAt", "shippedAt", "carrier", "logisticsNo", "destination", "requiresApproval", "deviationReason", "status", "createdAt", "updatedAt", "execution", "item", "evidence", "receipts", "exceptions"],
  properties: {
    id: positiveInteger, executionOrderId: positiveInteger, batchNo: { type: "string", minLength: 1 },
    quantity: positiveInteger, plannedShipAt: { type: "string", minLength: 1 }, shippedAt: nullableString,
    carrier: { type: "string" }, logisticsNo: { type: "string" }, destination: { type: "string" },
    requiresApproval: { type: "boolean" }, deviationReason: nullableString,
    status: { type: "string", minLength: 1 }, ...timestamps,
    execution: executionSchema, item: itemSchema,
    evidence: { type: "array", maxItems: 1_000, items: evidenceSchema },
    receipts: { type: "array", maxItems: 1_000, items: receiptSchema },
    exceptions: { type: "array", maxItems: 1_000, items: exceptionSchema },
  },
} as const;

export const shipmentsResponseSchema = {
  $id: shipmentsSchemaId,
  type: "object", additionalProperties: false, required: ["shipments"],
  properties: {
    shipments: { type: "array", maxItems: 200, items: shipmentSchema },
    preview: { const: true },
  },
} as const;
