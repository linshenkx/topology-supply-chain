export const SUPPLY_IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const SUPPLY_REQUEST_DIGEST_HEADER = "x-request-digest";

export const SUPPLY_COMMANDS = [
  "imports.preview",
  "imports.stage",
  "imports.commit",
  "master-data.write",
  "suppliers.write",
  "supplier-skus.write",
  "supplier-prices.write",
  "supplier-performance.write",
  "purchase-plans.create",
  "purchase-plans.update",
  "purchase-orders.create",
  "purchase-orders.update",
] as const;

export type SupplyCommandName = (typeof SUPPLY_COMMANDS)[number];

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
} satisfies Readonly<Record<string, SupplyCommandName>>);

export interface SupplyCommandMetadata {
  command: SupplyCommandName;
  idempotencyKey: string;
  requestDigest: string;
  replayed: boolean;
}

export interface SupplyCommandResponse<Result extends Record<string, unknown> = Record<string, unknown>> {
  command: SupplyCommandMetadata;
  result: Result;
}

export const supplyCommandHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [SUPPLY_IDEMPOTENCY_KEY_HEADER],
  properties: {
    [SUPPLY_IDEMPOTENCY_KEY_HEADER]: {
      type: "string", minLength: 16, maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$",
    },
    "x-csrf-token": {
      type: "string", minLength: 32, maxLength: 128,
      pattern: "^[A-Fa-f0-9]+$",
    },
    [SUPPLY_REQUEST_DIGEST_HEADER]: {
      type: "string", minLength: 64, maxLength: 64,
      pattern: "^[A-Fa-f0-9]{64}$",
    },
  },
} as const;

export const supplyCommandResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "result"],
  properties: {
    command: {
      type: "object",
      additionalProperties: false,
      required: ["command", "idempotencyKey", "requestDigest", "replayed"],
      properties: {
        command: { enum: SUPPLY_COMMANDS },
        idempotencyKey: { type: "string", minLength: 16, maxLength: 128 },
        requestDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        replayed: { type: "boolean" },
      },
    },
    result: { type: "object", additionalProperties: true },
  },
} as const;

export const supplyJsonCommandBodySchema = {
  type: "object",
  additionalProperties: true,
} as const;
