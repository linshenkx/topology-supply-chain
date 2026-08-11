export const approvalsSchemaId = "Approvals";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

export interface ApprovalListItem {
  id: number;
  requestNo: string;
  workflowType: string;
  summary: string;
  highRisk: boolean;
  status: ApprovalStatus;
  requestedAt: string;
}

export interface ApprovalsResponse {
  approvals: ApprovalListItem[];
  preview?: true;
}

export const approvalsResponseSchema = {
  $id: approvalsSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["approvals"],
  properties: {
    approvals: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "requestNo",
          "workflowType",
          "summary",
          "highRisk",
          "status",
          "requestedAt",
        ],
        properties: {
          id: { type: "integer", minimum: 1 },
          requestNo: { type: "string", minLength: 1 },
          workflowType: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          highRisk: { type: "boolean" },
          status: {
            type: "string",
            enum: ["pending", "approved", "rejected", "cancelled"],
          },
          requestedAt: { type: "string", minLength: 1 },
        },
      },
    },
    preview: { const: true },
  },
} as const;
