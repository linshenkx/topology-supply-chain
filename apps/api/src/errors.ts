import type {
  ApiErrorResponse,
  PlatformErrorCode,
} from "@topology/contracts";

interface PublicErrorDescriptor {
  code: string;
  message: string;
}

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly details?: Record<string, unknown>;
  readonly statusCode: number;

  constructor(
    statusCode: number,
    code: PlatformErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlatformError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const publicErrorsByStatus = new Map<number, PublicErrorDescriptor>([
  [400, { code: "BAD_REQUEST", message: "Bad Request" }],
  [401, { code: "UNAUTHORIZED", message: "Unauthorized" }],
  [403, { code: "FORBIDDEN", message: "Forbidden" }],
  [404, { code: "NOT_FOUND", message: "Route not found" }],
  [405, { code: "METHOD_NOT_ALLOWED", message: "Method Not Allowed" }],
  [409, { code: "CONFLICT", message: "Conflict" }],
  [429, { code: "TOO_MANY_REQUESTS", message: "Too Many Requests" }],
]);

export function resolvePublicError(statusCode: number): PublicErrorDescriptor {
  if (statusCode >= 500) {
    return { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" };
  }

  return (
    publicErrorsByStatus.get(statusCode) ?? {
      code: "REQUEST_FAILED",
      message: "Request Failed",
    }
  );
}

export function createApiErrorResponse(
  statusCode: number,
  requestId: string,
): ApiErrorResponse {
  const publicError = resolvePublicError(statusCode);

  return {
    ...publicError,
    requestId,
  };
}

export function createErrorResponse(
  error: unknown,
  statusCode: number,
  requestId: string,
): ApiErrorResponse {
  if (error instanceof PlatformError) {
    return {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return createApiErrorResponse(statusCode, requestId);
}
