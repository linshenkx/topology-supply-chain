export const apiErrorSchemaId = "ApiError";

export interface ApiErrorResponse {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

export type PlatformErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "ORIGIN_REJECTED"
  | "CSRF_REJECTED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "COMMAND_IN_PROGRESS"
  | "COMMAND_OUTCOME_UNKNOWN"
  | "VERSION_CONFLICT"
  | "WRITER_FENCE_REJECTED"
  | "OTP_EXPIRED"
  | "OTP_ATTEMPTS_EXCEEDED"
  | "FILE_QUARANTINED"
  | "FILE_TYPE_REJECTED"
  | "INTERNAL_SERVER_ERROR";

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
