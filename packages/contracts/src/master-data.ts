export const masterDataSchemaId = "MasterData";

export type MasterDataSkuItemType =
  | "finished"
  | "auxiliary"
  | "component"
  | null;

export interface MasterDataSku {
  id: number;
  code: string;
  name: string;
  itemType: MasterDataSkuItemType;
  stockUnit: string | null;
  status: "draft" | "active" | "inactive";
  verificationStatus: "pending" | "approved" | "rejected";
}

export interface MasterDataUnitConversion {
  id: number;
  skuId: number;
  purchaseUnit: string;
  stockUnit: string;
  purchaseUnitQuantity: number;
  stockUnitQuantity: number;
  effectiveFrom: string;
  status: "active" | "inactive";
}

export type MasterDataBomApprovalStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected";

export type MasterDataBomLifecycleStatus =
  | "inactive"
  | MasterDataBomApprovalStatus
  | "future"
  | "expired"
  | "effective";

export interface MasterDataBom {
  id: number;
  finishedSku: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvalStatus: MasterDataBomApprovalStatus;
  overlapAllowed: boolean;
  overlapReason: string;
  active: boolean;
  lifecycleStatus: MasterDataBomLifecycleStatus;
}

export interface MasterDataBomComponent {
  id: number;
  bomId: number;
  componentSku: string;
  itemType: "auxiliary" | "component";
  quantityPerFinished: number;
  isCore: boolean;
  issueToleranceBps: number;
  consumptionToleranceBps: number;
  lossToleranceBps: number;
}

export interface MasterDataResponse {
  skus: MasterDataSku[];
  conversions: MasterDataUnitConversion[];
  boms: MasterDataBom[];
  components: MasterDataBomComponent[];
  preview?: true;
}

const nullableStringSchema = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const;

export const masterDataResponseSchema = {
  $id: masterDataSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["skus", "conversions", "boms", "components"],
  properties: {
    skus: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "code",
          "name",
          "itemType",
          "stockUnit",
          "status",
          "verificationStatus",
        ],
        properties: {
          id: positiveIntegerSchema,
          code: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          itemType: {
            anyOf: [
              { type: "null" },
              {
                type: "string",
                enum: ["finished", "auxiliary", "component"],
              },
            ],
          },
          stockUnit: nullableStringSchema,
          status: {
            type: "string",
            enum: ["draft", "active", "inactive"],
          },
          verificationStatus: {
            type: "string",
            enum: ["pending", "approved", "rejected"],
          },
        },
      },
    },
    conversions: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "skuId",
          "purchaseUnit",
          "stockUnit",
          "purchaseUnitQuantity",
          "stockUnitQuantity",
          "effectiveFrom",
          "status",
        ],
        properties: {
          id: positiveIntegerSchema,
          skuId: positiveIntegerSchema,
          purchaseUnit: { type: "string", minLength: 1 },
          stockUnit: { type: "string", minLength: 1 },
          purchaseUnitQuantity: positiveIntegerSchema,
          stockUnitQuantity: positiveIntegerSchema,
          effectiveFrom: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["active", "inactive"] },
        },
      },
    },
    boms: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "finishedSku",
          "version",
          "effectiveFrom",
          "effectiveTo",
          "approvalStatus",
          "overlapAllowed",
          "overlapReason",
          "active",
          "lifecycleStatus",
        ],
        properties: {
          id: positiveIntegerSchema,
          finishedSku: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          effectiveFrom: { type: "string", minLength: 1 },
          effectiveTo: nullableStringSchema,
          approvalStatus: {
            type: "string",
            enum: ["draft", "pending", "approved", "rejected"],
          },
          overlapAllowed: { type: "boolean" },
          overlapReason: { type: "string" },
          active: { type: "boolean" },
          lifecycleStatus: {
            type: "string",
            enum: [
              "inactive",
              "draft",
              "pending",
              "approved",
              "rejected",
              "future",
              "expired",
              "effective",
            ],
          },
        },
      },
    },
    components: {
      type: "array",
      maxItems: 2_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "bomId",
          "componentSku",
          "itemType",
          "quantityPerFinished",
          "isCore",
          "issueToleranceBps",
          "consumptionToleranceBps",
          "lossToleranceBps",
        ],
        properties: {
          id: positiveIntegerSchema,
          bomId: positiveIntegerSchema,
          componentSku: { type: "string", minLength: 1 },
          itemType: {
            type: "string",
            enum: ["auxiliary", "component"],
          },
          quantityPerFinished: positiveIntegerSchema,
          isCore: { type: "boolean" },
          issueToleranceBps: nonNegativeIntegerSchema,
          consumptionToleranceBps: nonNegativeIntegerSchema,
          lossToleranceBps: nonNegativeIntegerSchema,
        },
      },
    },
    preview: { const: true },
  },
} as const;
