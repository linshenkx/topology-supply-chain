export const qualityInspectionsSchemaId = "QualityInspections";

export interface QualityInspection {
  id: number;
  executionOrderId: number | null;
  batchId: number | null;
  stage: "incoming" | "finished_goods";
  inspectionMethod: "sampling" | "full";
  batchQuantity: number;
  inspectedQuantity: number;
  passedQuantity: number;
  failedQuantity: number;
  passRateBps: number;
  qualityRuleId: number;
  usedItemTypeFallback: boolean;
  skuRuleReminderStatus: "not_needed" | "pending" | "completed";
  defectReason: string;
  systemResult: "passed" | "failed";
  requestedResult: "passed" | "failed" | null;
  requiresApproval: boolean;
  finalResult: "passed" | "failed" | "pending_approval" | null;
  quarantineTriggered: boolean;
  fullInspectionRequired: boolean;
  sourceInspectionId: number | null;
  releasedQuantity: number;
  dispositionStatus: "not_needed" | "pending" | "completed";
  inspectorType: "supplier_qc" | "company_qc";
  submittedBy: number;
  createdAt: string;
  updatedAt: string;
}

export interface QualityInspectionsResponse {
  inspections: QualityInspection[];
  preview?: true;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nullablePositiveInteger = {
  anyOf: [{ type: "null" }, positiveInteger],
} as const;
const nullableResult = {
  anyOf: [
    { type: "null" },
    { type: "string", enum: ["passed", "failed"] },
  ],
} as const;
const nullableFinalResult = {
  anyOf: [
    { type: "null" },
    {
      type: "string",
      enum: ["passed", "failed", "pending_approval"],
    },
  ],
} as const;

export const qualityInspectionsResponseSchema = {
  $id: qualityInspectionsSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["inspections"],
  properties: {
    inspections: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "executionOrderId",
          "batchId",
          "stage",
          "inspectionMethod",
          "batchQuantity",
          "inspectedQuantity",
          "passedQuantity",
          "failedQuantity",
          "passRateBps",
          "qualityRuleId",
          "usedItemTypeFallback",
          "skuRuleReminderStatus",
          "defectReason",
          "systemResult",
          "requestedResult",
          "requiresApproval",
          "finalResult",
          "quarantineTriggered",
          "fullInspectionRequired",
          "sourceInspectionId",
          "releasedQuantity",
          "dispositionStatus",
          "inspectorType",
          "submittedBy",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: positiveInteger,
          executionOrderId: nullablePositiveInteger,
          batchId: nullablePositiveInteger,
          stage: { type: "string", enum: ["incoming", "finished_goods"] },
          inspectionMethod: { type: "string", enum: ["sampling", "full"] },
          batchQuantity: positiveInteger,
          inspectedQuantity: positiveInteger,
          passedQuantity: nonNegativeInteger,
          failedQuantity: nonNegativeInteger,
          passRateBps: nonNegativeInteger,
          qualityRuleId: positiveInteger,
          usedItemTypeFallback: { type: "boolean" },
          skuRuleReminderStatus: {
            type: "string",
            enum: ["not_needed", "pending", "completed"],
          },
          defectReason: { type: "string" },
          systemResult: { type: "string", enum: ["passed", "failed"] },
          requestedResult: nullableResult,
          requiresApproval: { type: "boolean" },
          finalResult: nullableFinalResult,
          quarantineTriggered: { type: "boolean" },
          fullInspectionRequired: { type: "boolean" },
          sourceInspectionId: nullablePositiveInteger,
          releasedQuantity: nonNegativeInteger,
          dispositionStatus: {
            type: "string",
            enum: ["not_needed", "pending", "completed"],
          },
          inspectorType: {
            type: "string",
            enum: ["supplier_qc", "company_qc"],
          },
          submittedBy: positiveInteger,
          createdAt: { type: "string", minLength: 1 },
          updatedAt: { type: "string", minLength: 1 },
        },
      },
    },
    preview: { const: true },
  },
} as const;

export const qualityPendingBatchesSchemaId = "QualityPendingBatches";

export type QualityPendingBatchSource = "receipt" | "production";

export interface QualityPendingBatch {
  batchId: number;
  batchNo: string;
  warehouseId: number;
  warehouseName: string;
  sku: string;
  pendingInspectionQuantity: number;
  source: QualityPendingBatchSource;
  stage: "incoming" | "finished_goods";
}

export interface QualityPendingBatchesResponse {
  pendingBatches: QualityPendingBatch[];
  preview?: true;
}

const pendingBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "batchId",
    "batchNo",
    "warehouseId",
    "warehouseName",
    "sku",
    "pendingInspectionQuantity",
    "source",
    "stage",
  ],
  properties: {
    batchId: positiveInteger,
    batchNo: { type: "string", minLength: 1 },
    warehouseId: positiveInteger,
    warehouseName: { type: "string", minLength: 1 },
    sku: { type: "string", minLength: 1 },
    pendingInspectionQuantity: positiveInteger,
    source: { type: "string", enum: ["receipt", "production"] },
    stage: { type: "string", enum: ["incoming", "finished_goods"] },
  },
} as const;

export const qualityPendingBatchesResponseSchema = {
  $id: qualityPendingBatchesSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["pendingBatches"],
  properties: {
    pendingBatches: {
      type: "array",
      maxItems: 200,
      items: pendingBatchSchema,
    },
    preview: { const: true },
  },
} as const;
