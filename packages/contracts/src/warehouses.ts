export const warehousesSchemaId = "Warehouses";

export interface WarehouseFactory {
  id: number;
  name: string;
  code: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseBlockers {
  inventory: number;
  reservations: number;
  transfers: number;
  unfinishedBusiness: number;
}

export interface Warehouse {
  id: number;
  code: string;
  name: string;
  type: "factory" | "company" | "other";
  factoryId: number | null;
  address: string;
  status: "active" | "inactive" | "merged";
  createdAt: string;
  updatedAt: string;
  mergedIntoWarehouseId: number | null;
  blockers: WarehouseBlockers;
}

export interface WarehousesResponse {
  warehouses: Warehouse[];
  factories: WarehouseFactory[];
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = { anyOf: [positiveInteger, { type: "null" }] } as const;
const timestamps = { createdAt: { type: "string", minLength: 1 }, updatedAt: { type: "string", minLength: 1 } } as const;

const factorySchema = {
  type: "object", additionalProperties: false,
  required: ["id", "name", "code", "status", "createdAt", "updatedAt"],
  properties: {
    id: positiveInteger, name: { type: "string", minLength: 1 }, code: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 }, ...timestamps,
  },
} as const;

const warehouseSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "code", "name", "type", "factoryId", "address", "status", "createdAt", "updatedAt", "mergedIntoWarehouseId", "blockers"],
  properties: {
    id: positiveInteger, code: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["factory", "company", "other"] }, factoryId: nullablePositiveInteger,
    address: { type: "string" }, status: { type: "string", enum: ["active", "inactive", "merged"] },
    ...timestamps, mergedIntoWarehouseId: nullablePositiveInteger,
    blockers: {
      type: "object", additionalProperties: false,
      required: ["inventory", "reservations", "transfers", "unfinishedBusiness"],
      properties: {
        inventory: nonNegativeInteger, reservations: nonNegativeInteger,
        transfers: nonNegativeInteger, unfinishedBusiness: nonNegativeInteger,
      },
    },
  },
} as const;

export const warehousesResponseSchema = {
  $id: warehousesSchemaId,
  type: "object", additionalProperties: false, required: ["warehouses", "factories"],
  properties: {
    warehouses: { type: "array", maxItems: 500, items: warehouseSchema },
    factories: { type: "array", maxItems: 500, items: factorySchema },
    preview: { const: true },
  },
} as const;
