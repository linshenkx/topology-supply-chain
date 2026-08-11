export const apiErrorSchemaId = "ApiError";

export interface ApiErrorResponse {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export const apiErrorResponseSchema = {
  $id: apiErrorSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "requestId"],
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    details: { type: "object", additionalProperties: true },
  },
} as const;
