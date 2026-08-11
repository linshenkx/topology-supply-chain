export const inventorySchemaId = "Inventory";

export interface InventoryQuery {
  warehouseId?: string;
  sku?: string;
  sensitive?: string;
}

export interface InventoryWarehouse {
  id: number;
  code: string;
  name: string;
  type: "factory" | "company" | "other";
  factoryId: number | null;
  address: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryBatch {
  id: number;
  batchNo: string;
  warehouseId: number;
  sku: string;
  productionDate: string | null;
  inboundDate: string;
  expiryDate: string | null;
  productionDateEstimated: boolean;
  expiryDateEstimated: boolean;
  availableQuantity: number;
  lockedQuantity: number;
  defectiveQuantity: number;
  pendingInspectionQuantity: number;
  quarantineQuantity: number;
  ownership: "company" | "factory";
  expiryStatus: "normal" | "yellow" | "red" | "expired_frozen";
  createdAt: string;
  updatedAt: string;
}

export interface InventoryReservation {
  id: number;
  batchId: number;
  entityType: "purchase_order" | "production_order" | "shipment_plan" | "historical";
  entityId: number | null;
  requestedQuantity: number;
  reservedQuantity: number;
  shortageQuantity: number;
  priority: number;
  status: "active";
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryTransfer {
  id: number;
  transferNo: string;
  fromWarehouseId: number;
  toWarehouseId: number;
  sku: string;
  quantity: number;
  reason: string;
  status: string;
  requestedBy: number;
  approvedBy: number | null;
  approvedAt: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryResponse {
  batches: InventoryBatch[];
  warehouses?: InventoryWarehouse[];
  reservations?: InventoryReservation[];
  transfers?: InventoryTransfer[];
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
const timestamps = {
  createdAt: { type: "string", minLength: 1 },
  updatedAt: { type: "string", minLength: 1 },
} as const;

const warehouseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "type", "factoryId", "address", "status", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    code: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["factory", "company", "other"] },
    factoryId: nullablePositiveInteger,
    address: { type: "string" },
    status: { type: "string", minLength: 1 },
    ...timestamps,
  },
} as const;

const batchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "batchNo", "warehouseId", "sku", "productionDate", "inboundDate", "expiryDate", "productionDateEstimated", "expiryDateEstimated", "availableQuantity", "lockedQuantity", "defectiveQuantity", "pendingInspectionQuantity", "quarantineQuantity", "ownership", "expiryStatus", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    batchNo: { type: "string", minLength: 1 },
    warehouseId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    productionDate: nullableString,
    inboundDate: { type: "string", minLength: 1 },
    expiryDate: nullableString,
    productionDateEstimated: { type: "boolean" },
    expiryDateEstimated: { type: "boolean" },
    availableQuantity: nonNegativeInteger,
    lockedQuantity: nonNegativeInteger,
    defectiveQuantity: nonNegativeInteger,
    pendingInspectionQuantity: nonNegativeInteger,
    quarantineQuantity: nonNegativeInteger,
    ownership: { type: "string", enum: ["company", "factory"] },
    expiryStatus: { type: "string", enum: ["normal", "yellow", "red", "expired_frozen"] },
    ...timestamps,
  },
} as const;

const reservationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "batchId", "entityType", "entityId", "requestedQuantity", "reservedQuantity", "shortageQuantity", "priority", "status", "createdBy", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    batchId: positiveInteger,
    entityType: { type: "string", enum: ["purchase_order", "production_order", "shipment_plan", "historical"] },
    entityId: nullablePositiveInteger,
    requestedQuantity: positiveInteger,
    reservedQuantity: nonNegativeInteger,
    shortageQuantity: nonNegativeInteger,
    priority: { type: "integer" },
    status: { const: "active" },
    createdBy: positiveInteger,
    ...timestamps,
  },
} as const;

const transferSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "transferNo", "fromWarehouseId", "toWarehouseId", "sku", "quantity", "reason", "status", "requestedBy", "approvedBy", "approvedAt", "shippedAt", "receivedAt", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    transferNo: { type: "string", minLength: 1 },
    fromWarehouseId: positiveInteger,
    toWarehouseId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    quantity: positiveInteger,
    reason: { type: "string" },
    status: { type: "string", minLength: 1 },
    requestedBy: positiveInteger,
    approvedBy: nullablePositiveInteger,
    approvedAt: nullableString,
    shippedAt: nullableString,
    receivedAt: nullableString,
    ...timestamps,
  },
} as const;

export const inventoryResponseSchema = {
  $id: inventorySchemaId,
  type: "object",
  additionalProperties: false,
  required: ["batches"],
  properties: {
    batches: { type: "array", maxItems: 500, items: batchSchema },
    warehouses: { type: "array", maxItems: 500, items: warehouseSchema },
    reservations: { type: "array", maxItems: 200, items: reservationSchema },
    transfers: { type: "array", maxItems: 100, items: transferSchema },
    preview: { const: true },
  },
} as const;
