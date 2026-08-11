export const suppliersSchemaId = "Suppliers";
export const supplierSkusSchemaId = "SupplierSkus";
export const supplierPricesSchemaId = "SupplierPrices";
export const supplierPerformanceSchemaId = "SupplierPerformance";

export type SupplierVerificationStatus = "pending" | "approved" | "rejected";
export type SupplierSkuStatus = "pending" | "active" | "inactive";
export type SupplierReviewType = "satisfaction" | "sampling";
export type SupplierMetricKey =
  | "delivery"
  | "quality"
  | "exception"
  | "preparation"
  | "satisfaction"
  | "sampling";

export interface SupplierProfile {
  id: number;
  code: string;
  name: string;
  tier: number | null;
  managedByFactoryId: number | null;
  unifiedSocialCreditCode: string;
  address: string;
  contactName: string;
  contactPhone: string;
  businessScope: string;
  verificationStatus: SupplierVerificationStatus;
  status: string;
}

export interface SupplierSummary {
  id: number;
  code: string;
  name: string;
  tier: number | null;
  managedByFactoryId: number | null;
  status: string;
}

export interface SupplierFactory {
  id: number;
  code: string;
  name: string;
  status: string;
}

export interface SupplierSkuCatalogItem {
  id: number;
  code: string;
  name: string;
  itemType: "finished" | "auxiliary" | "component" | null;
  stockUnit: string | null;
}

export interface SupplierSkuRelation {
  id: number;
  factoryId: number;
  supplierId: number;
  sku: string;
  isPrimary: boolean;
  priority: number;
  minimumOrderQuantity: number;
  packagingMultiple: number;
  purchaseUnit: string;
  leadTimeDays: number | null;
  dailyCapacity: number | null;
  monthlyCapacity: number | null;
  effectiveFrom: string;
  status: SupplierSkuStatus;
}

export interface SuppliersResponse {
  suppliers: SupplierProfile[];
  factories?: SupplierFactory[];
  preview?: true;
}

export interface SupplierSkusResponse {
  relations: SupplierSkuRelation[];
  suppliers?: SupplierSummary[];
  factories?: SupplierFactory[];
  skus?: SupplierSkuCatalogItem[];
  preview?: true;
}

export interface SupplierPriceAgreement {
  id: number;
  supplierId: number;
  sku: string;
  currency: string;
  unitPriceTaxIncludedMinor: number;
  unitPriceTaxExcludedMinor: number;
  taxRateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
}

export interface SupplierPriceChangeRequest {
  id: number;
  currentAgreementId: number | null;
  supplierId: number;
  sku: string;
  proposedTaxIncludedMinor: number;
  proposedTaxExcludedMinor: number;
  proposedTaxRateBps: number;
  proposedEffectiveFrom: string;
  reason: string;
  decision: "pending" | "approved" | "rejected";
}

export interface SupplierCapacityRisk {
  relationId: number;
  factoryId: number;
  supplierId: number;
  sku: string;
  periodType: "day" | "month";
  period: string;
  demand: number;
  capacity: number;
  excess: number;
}

export interface SupplierPricesResponse {
  agreements: SupplierPriceAgreement[];
  requests: SupplierPriceChangeRequest[];
  suppliers: SupplierSummary[];
  skus: SupplierSkuCatalogItem[];
  relations: SupplierSkuRelation[];
  risks: SupplierCapacityRisk[];
  preview?: true;
}

export type SupplierPerformanceMetrics = Record<
  SupplierMetricKey,
  number | null
>;
export type SupplierPerformanceWeights = Record<SupplierMetricKey, number>;

export interface SupplierPerformanceComment {
  type: SupplierReviewType;
  comment: string;
  tags: string[];
}

export interface SupplierPerformanceRanking {
  supplierId: number | null;
  supplierCode: string | null;
  supplierName: string | null;
  displayName: string;
  tier: number;
  rank: number;
  score: number | null;
  metrics: SupplierPerformanceMetrics;
  automaticMetricEvidence: {
    delivery: { evaluatedBatches: number; onTimeBatches: number };
  };
  reviewCounts: { satisfaction: number; sampling: number };
  comments: SupplierPerformanceComment[];
  reveal: boolean;
}

export interface SupplierPerformanceWeight extends SupplierPerformanceWeights {
  tier: number;
}

export interface SupplierPerformanceResponse {
  quarter: string;
  rankings: SupplierPerformanceRanking[];
  weights: SupplierPerformanceWeight[];
  canConfigure: boolean;
  canReview: boolean;
  automaticMetricsPending: true;
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
const nullableNumber = {
  anyOf: [{ type: "null" }, { type: "number", minimum: 0, maximum: 100 }],
} as const;

const factorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "status"],
  properties: {
    id: positiveInteger,
    code: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
  },
} as const;

const supplierSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "tier", "managedByFactoryId", "status"],
  properties: {
    id: positiveInteger,
    code: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    tier: nullablePositiveInteger,
    managedByFactoryId: nullablePositiveInteger,
    status: { type: "string", minLength: 1 },
  },
} as const;

const supplierProfileSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "code",
    "name",
    "tier",
    "managedByFactoryId",
    "unifiedSocialCreditCode",
    "address",
    "contactName",
    "contactPhone",
    "businessScope",
    "verificationStatus",
    "status",
  ],
  properties: {
    ...supplierSummarySchema.properties,
    unifiedSocialCreditCode: { type: "string" },
    address: { type: "string" },
    contactName: { type: "string" },
    contactPhone: { type: "string" },
    businessScope: { type: "string" },
    verificationStatus: {
      type: "string",
      enum: ["pending", "approved", "rejected"],
    },
  },
} as const;

const skuSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "code", "name", "itemType", "stockUnit"],
  properties: {
    id: positiveInteger,
    code: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    itemType: {
      anyOf: [
        { type: "null" },
        { type: "string", enum: ["finished", "auxiliary", "component"] },
      ],
    },
    stockUnit: nullableString,
  },
} as const;

const relationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "factoryId",
    "supplierId",
    "sku",
    "isPrimary",
    "priority",
    "minimumOrderQuantity",
    "packagingMultiple",
    "purchaseUnit",
    "leadTimeDays",
    "dailyCapacity",
    "monthlyCapacity",
    "effectiveFrom",
    "status",
  ],
  properties: {
    id: positiveInteger,
    factoryId: positiveInteger,
    supplierId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    isPrimary: { type: "boolean" },
    priority: positiveInteger,
    minimumOrderQuantity: positiveInteger,
    packagingMultiple: positiveInteger,
    purchaseUnit: { type: "string" },
    leadTimeDays: {
      anyOf: [{ type: "null" }, nonNegativeInteger],
    },
    dailyCapacity: nullablePositiveInteger,
    monthlyCapacity: nullablePositiveInteger,
    effectiveFrom: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["pending", "active", "inactive"] },
  },
} as const;

export const suppliersResponseSchema = {
  $id: suppliersSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["suppliers"],
  properties: {
    suppliers: { type: "array", maxItems: 200, items: supplierProfileSchema },
    factories: { type: "array", maxItems: 200, items: factorySchema },
    preview: { const: true },
  },
} as const;

export const supplierSkusResponseSchema = {
  $id: supplierSkusSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["relations"],
  properties: {
    relations: { type: "array", maxItems: 500, items: relationSchema },
    suppliers: { type: "array", maxItems: 500, items: supplierSummarySchema },
    factories: { type: "array", maxItems: 200, items: factorySchema },
    skus: { type: "array", maxItems: 1_000, items: skuSchema },
    preview: { const: true },
  },
} as const;

const agreementSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "supplierId",
    "sku",
    "currency",
    "unitPriceTaxIncludedMinor",
    "unitPriceTaxExcludedMinor",
    "taxRateBps",
    "effectiveFrom",
    "effectiveTo",
    "status",
  ],
  properties: {
    id: positiveInteger,
    supplierId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    currency: { type: "string", minLength: 1 },
    unitPriceTaxIncludedMinor: nonNegativeInteger,
    unitPriceTaxExcludedMinor: nonNegativeInteger,
    taxRateBps: { type: "integer", minimum: 0, maximum: 10_000 },
    effectiveFrom: { type: "string", minLength: 1 },
    effectiveTo: nullableString,
    status: { type: "string", minLength: 1 },
  },
} as const;

const priceRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "currentAgreementId",
    "supplierId",
    "sku",
    "proposedTaxIncludedMinor",
    "proposedTaxExcludedMinor",
    "proposedTaxRateBps",
    "proposedEffectiveFrom",
    "reason",
    "decision",
  ],
  properties: {
    id: positiveInteger,
    currentAgreementId: nullablePositiveInteger,
    supplierId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    proposedTaxIncludedMinor: nonNegativeInteger,
    proposedTaxExcludedMinor: nonNegativeInteger,
    proposedTaxRateBps: { type: "integer", minimum: 0, maximum: 10_000 },
    proposedEffectiveFrom: { type: "string", minLength: 1 },
    reason: { type: "string" },
    decision: { type: "string", enum: ["pending", "approved", "rejected"] },
  },
} as const;

const riskSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "relationId",
    "factoryId",
    "supplierId",
    "sku",
    "periodType",
    "period",
    "demand",
    "capacity",
    "excess",
  ],
  properties: {
    relationId: positiveInteger,
    factoryId: positiveInteger,
    supplierId: positiveInteger,
    sku: { type: "string", minLength: 1 },
    periodType: { type: "string", enum: ["day", "month"] },
    period: { type: "string", minLength: 1 },
    demand: positiveInteger,
    capacity: positiveInteger,
    excess: positiveInteger,
  },
} as const;

export const supplierPricesResponseSchema = {
  $id: supplierPricesSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["agreements", "requests", "suppliers", "skus", "relations", "risks"],
  properties: {
    agreements: { type: "array", maxItems: 2_000, items: agreementSchema },
    requests: { type: "array", maxItems: 500, items: priceRequestSchema },
    suppliers: { type: "array", maxItems: 500, items: supplierSummarySchema },
    skus: { type: "array", maxItems: 1_000, items: skuSchema },
    relations: { type: "array", maxItems: 2_000, items: relationSchema },
    risks: { type: "array", maxItems: 10_000, items: riskSchema },
    preview: { const: true },
  },
} as const;

const metricProperties = {
  delivery: nullableNumber,
  quality: nullableNumber,
  exception: nullableNumber,
  preparation: nullableNumber,
  satisfaction: nullableNumber,
  sampling: nullableNumber,
} as const;

const metricRequired = [
  "delivery",
  "quality",
  "exception",
  "preparation",
  "satisfaction",
  "sampling",
] as const;

const weightProperties = {
  delivery: nonNegativeInteger,
  quality: nonNegativeInteger,
  exception: nonNegativeInteger,
  preparation: nonNegativeInteger,
  satisfaction: nonNegativeInteger,
  sampling: nonNegativeInteger,
} as const;

const performanceWeightSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier", ...metricRequired],
  properties: { tier: { type: "integer", minimum: 1, maximum: 3 }, ...weightProperties },
} as const;

const performanceRankingSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "supplierId",
    "supplierCode",
    "supplierName",
    "displayName",
    "tier",
    "rank",
    "score",
    "metrics",
    "automaticMetricEvidence",
    "reviewCounts",
    "comments",
    "reveal",
  ],
  properties: {
    supplierId: nullablePositiveInteger,
    supplierCode: nullableString,
    supplierName: nullableString,
    displayName: { type: "string", minLength: 1 },
    tier: { type: "integer", minimum: 1, maximum: 3 },
    rank: positiveInteger,
    score: nullableNumber,
    metrics: {
      type: "object",
      additionalProperties: false,
      required: metricRequired,
      properties: metricProperties,
    },
    automaticMetricEvidence: {
      type: "object",
      additionalProperties: false,
      required: ["delivery"],
      properties: {
        delivery: {
          type: "object",
          additionalProperties: false,
          required: ["evaluatedBatches", "onTimeBatches"],
          properties: {
            evaluatedBatches: nonNegativeInteger,
            onTimeBatches: nonNegativeInteger,
          },
        },
      },
    },
    reviewCounts: {
      type: "object",
      additionalProperties: false,
      required: ["satisfaction", "sampling"],
      properties: {
        satisfaction: nonNegativeInteger,
        sampling: nonNegativeInteger,
      },
    },
    comments: {
      type: "array",
      maxItems: 5_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "comment", "tags"],
        properties: {
          type: { type: "string", enum: ["satisfaction", "sampling"] },
          comment: { type: "string" },
          tags: { type: "array", maxItems: 100, items: { type: "string" } },
        },
      },
    },
    reveal: { type: "boolean" },
  },
} as const;

export const supplierPerformanceResponseSchema = {
  $id: supplierPerformanceSchemaId,
  type: "object",
  additionalProperties: false,
  required: [
    "quarter",
    "rankings",
    "weights",
    "canConfigure",
    "canReview",
    "automaticMetricsPending",
  ],
  properties: {
    quarter: { type: "string", pattern: "^[0-9]{4}-Q[1-4]$" },
    rankings: { type: "array", maxItems: 500, items: performanceRankingSchema },
    weights: { type: "array", minItems: 3, maxItems: 3, items: performanceWeightSchema },
    canConfigure: { type: "boolean" },
    canReview: { type: "boolean" },
    automaticMetricsPending: { const: true },
    preview: { const: true },
  },
} as const;
