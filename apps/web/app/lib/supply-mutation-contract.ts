export type SupplyMutationPath =
  | "/api/v1/imports/preview"
  | "/api/v1/imports/stage"
  | "/api/v1/imports/commit"
  | "/api/v1/master-data"
  | "/api/v1/suppliers"
  | "/api/v1/supplier-skus"
  | "/api/v1/supplier-prices"
  | "/api/v1/supplier-performance"
  | "/api/v1/purchase-plans"
  | "/api/v1/purchase-orders";

export const SUPPLY_COMMAND_BY_MUTATION = Object.freeze({
  "POST /api/v1/imports/preview": "imports.preview",
  "POST /api/v1/imports/stage": "imports.stage",
  "POST /api/v1/imports/commit": "imports.commit",
  "POST /api/v1/master-data": "master-data.write",
  "POST /api/v1/suppliers": "suppliers.write",
  "POST /api/v1/supplier-skus": "supplier-skus.write",
  "POST /api/v1/supplier-prices": "supplier-prices.write",
  "POST /api/v1/supplier-performance": "supplier-performance.write",
  "POST /api/v1/purchase-plans": "purchase-plans.create",
  "PATCH /api/v1/purchase-plans": "purchase-plans.update",
  "POST /api/v1/purchase-orders": "purchase-orders.create",
  "PATCH /api/v1/purchase-orders": "purchase-orders.update",
} as const);
