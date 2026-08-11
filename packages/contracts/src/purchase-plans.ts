export const purchasePlansSchemaId = "PurchasePlans";

export type PurchasePlanStatus =
  | "draft"
  | "pending_approval"
  | "awaiting_factory_confirmation"
  | "confirmed"
  | "disputed"
  | "ordering"
  | "ordered_complete"
  | "superseded";

export type PurchasePlanItemCompletionStatus =
  | "not_ordered"
  | "within_tolerance"
  | "over_plan_pending"
  | "under_plan_pending"
  | "exception_approved";

export interface PurchasePlanItem {
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
  completionStatus: PurchasePlanItemCompletionStatus;
  createdAt: string;
  updatedAt: string;
  factoryName: string;
  warehouseName: string;
}

export interface PurchasePlanFactoryResponse {
  id: number;
  purchasePlanId: number;
  factoryId: number;
  decision: "confirmed" | "unable";
  expectedStartDate: string;
  expectedFinishDate: string;
  proposedArrivalDate: string | null;
  reason: string;
  status: "accepted" | "pending_supply_chain" | "approved" | "rejected";
  respondedBy: number;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchasePlan {
  id: number;
  planNo: string;
  version: number;
  source: string;
  sourceFileKey: string | null;
  status: PurchasePlanStatus;
  confirmationDueAt: string | null;
  confirmedAt: string | null;
  createdBy: number;
  reviewedBy: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: PurchasePlanItem[];
  responses: PurchasePlanFactoryResponse[];
}

export interface PurchasePlansResponse {
  plans: PurchasePlan[];
  preview?: true;
}

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const;
const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const nullableStringSchema = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;
const nullablePositiveIntegerSchema = {
  anyOf: [positiveIntegerSchema, { type: "null" }],
} as const;

const purchasePlanItemSchema = {
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
    "factoryName",
    "warehouseName",
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
    factoryName: nonEmptyStringSchema,
    warehouseName: nonEmptyStringSchema,
  },
} as const;

const purchasePlanFactoryResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "purchasePlanId",
    "factoryId",
    "decision",
    "expectedStartDate",
    "expectedFinishDate",
    "proposedArrivalDate",
    "reason",
    "status",
    "respondedBy",
    "reviewedBy",
    "reviewedAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: positiveIntegerSchema,
    purchasePlanId: positiveIntegerSchema,
    factoryId: positiveIntegerSchema,
    decision: { type: "string", enum: ["confirmed", "unable"] },
    expectedStartDate: nonEmptyStringSchema,
    expectedFinishDate: nonEmptyStringSchema,
    proposedArrivalDate: nullableStringSchema,
    reason: { type: "string" },
    status: {
      type: "string",
      enum: ["accepted", "pending_supply_chain", "approved", "rejected"],
    },
    respondedBy: positiveIntegerSchema,
    reviewedBy: nullablePositiveIntegerSchema,
    reviewedAt: nullableStringSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  },
} as const;

export const purchasePlansResponseSchema = {
  $id: purchasePlansSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["plans"],
  properties: {
    plans: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "planNo",
          "version",
          "source",
          "sourceFileKey",
          "status",
          "confirmationDueAt",
          "confirmedAt",
          "createdBy",
          "reviewedBy",
          "reviewedAt",
          "createdAt",
          "updatedAt",
          "items",
          "responses",
        ],
        properties: {
          id: positiveIntegerSchema,
          planNo: nonEmptyStringSchema,
          version: positiveIntegerSchema,
          source: nonEmptyStringSchema,
          sourceFileKey: nullableStringSchema,
          status: {
            type: "string",
            enum: [
              "draft",
              "pending_approval",
              "awaiting_factory_confirmation",
              "confirmed",
              "disputed",
              "ordering",
              "ordered_complete",
              "superseded",
            ],
          },
          confirmationDueAt: nullableStringSchema,
          confirmedAt: nullableStringSchema,
          createdBy: positiveIntegerSchema,
          reviewedBy: nullablePositiveIntegerSchema,
          reviewedAt: nullableStringSchema,
          createdAt: nonEmptyStringSchema,
          updatedAt: nonEmptyStringSchema,
          items: {
            type: "array",
            maxItems: 2_000,
            items: purchasePlanItemSchema,
          },
          responses: {
            type: "array",
            maxItems: 2_000,
            items: purchasePlanFactoryResponseSchema,
          },
        },
      },
    },
    preview: { const: true },
  },
} as const;
