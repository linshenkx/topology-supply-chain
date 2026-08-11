export const stocktakesSchemaId = "Stocktakes";

export interface StocktakeWarehouse {
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

export interface StocktakeFactory {
  id: number;
  name: string;
  code: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface StocktakeTarget {
  batchId: number | null;
  sku: string;
  batchNo: string | null;
}

export interface StocktakeCount {
  id: number;
  stocktakeId: number;
  batchId: number | null;
  sku: string;
  countRound: number;
  availableQuantity: number;
  lockedQuantity: number;
  defectiveQuantity: number;
  pendingInspectionQuantity: number;
  totalQuantity: number;
  countedBy: number;
  countedAt: string;
}

export interface Stocktake {
  id: number;
  stocktakeNo: string;
  warehouseId: number;
  scope: "full_warehouse" | "sku_sample" | "batch";
  dueDate: string;
  status: "draft" | "frozen" | "first_count" | "recount" | "pending_approval" | "completed";
  frozenAt: string | null;
  createdBy: number;
  assignedFactoryId: number | null;
  createdAt: string;
  updatedAt: string;
  targets: StocktakeTarget[];
  counts: StocktakeCount[];
}

export interface StocktakesResponse {
  stocktakes: Stocktake[];
  warehouses: StocktakeWarehouse[];
  factories: StocktakeFactory[];
  canCreate: boolean;
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = { anyOf: [{ type: "null" }, positiveInteger] } as const;
const nullableString = { anyOf: [{ type: "null" }, { type: "string" }] } as const;
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

const factorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "code", "status", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger,
    name: { type: "string", minLength: 1 },
    code: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    ...timestamps,
  },
} as const;

const targetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batchId", "sku", "batchNo"],
  properties: {
    batchId: nullablePositiveInteger,
    sku: { type: "string", minLength: 1 },
    batchNo: nullableString,
  },
} as const;

const countSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "stocktakeId", "batchId", "sku", "countRound", "availableQuantity", "lockedQuantity", "defectiveQuantity", "pendingInspectionQuantity", "totalQuantity", "countedBy", "countedAt"],
  properties: {
    id: positiveInteger,
    stocktakeId: positiveInteger,
    batchId: nullablePositiveInteger,
    sku: { type: "string", minLength: 1 },
    countRound: { type: "integer", enum: [1, 2] },
    availableQuantity: nonNegativeInteger,
    lockedQuantity: nonNegativeInteger,
    defectiveQuantity: nonNegativeInteger,
    pendingInspectionQuantity: nonNegativeInteger,
    totalQuantity: nonNegativeInteger,
    countedBy: positiveInteger,
    countedAt: { type: "string", minLength: 1 },
  },
} as const;

const stocktakeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "stocktakeNo", "warehouseId", "scope", "dueDate", "status", "frozenAt", "createdBy", "assignedFactoryId", "createdAt", "updatedAt", "targets", "counts"],
  properties: {
    id: positiveInteger,
    stocktakeNo: { type: "string", minLength: 1 },
    warehouseId: positiveInteger,
    scope: { type: "string", enum: ["full_warehouse", "sku_sample", "batch"] },
    dueDate: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["draft", "frozen", "first_count", "recount", "pending_approval", "completed"] },
    frozenAt: nullableString,
    createdBy: positiveInteger,
    assignedFactoryId: nullablePositiveInteger,
    ...timestamps,
    targets: { type: "array", maxItems: 5_000, items: targetSchema },
    counts: { type: "array", maxItems: 10_000, items: countSchema },
  },
} as const;

export const stocktakesResponseSchema = {
  $id: stocktakesSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["stocktakes", "warehouses", "factories", "canCreate"],
  properties: {
    stocktakes: { type: "array", maxItems: 100, items: stocktakeSchema },
    warehouses: { type: "array", maxItems: 500, items: warehouseSchema },
    factories: { type: "array", maxItems: 500, items: factorySchema },
    canCreate: { type: "boolean" },
    preview: { const: true },
  },
} as const;
