import type { ApiErrorResponse } from "@topology/contracts";

interface PublicErrorDescriptor {
  code: string;
  message: string;
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
