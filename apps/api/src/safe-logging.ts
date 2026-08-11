import {
  LogController,
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

const redactedValue = "[REDACTED]";
const mandatoryRedactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
] as const;

type LoggerOptions = Exclude<
  FastifyServerOptions["logger"],
  boolean | undefined
>;

function mergedRedactOptions(
  redact: LoggerOptions["redact"],
): NonNullable<LoggerOptions["redact"]> {
  const mandatoryOptions = {
    paths: [...mandatoryRedactPaths],
    censor: redactedValue,
  };
  const mergePaths = (additionalPaths: readonly string[]) => [
    ...new Set([...mandatoryRedactPaths, ...additionalPaths]),
  ];

  if (Array.isArray(redact)) {
    return {
      paths: mergePaths(redact),
      censor: redactedValue,
    };
  }

  if (
    typeof redact !== "object" ||
    redact === null ||
    !Array.isArray(redact.paths) ||
    !redact.paths.every((path) => typeof path === "string") ||
    (redact.censor !== undefined && typeof redact.censor !== "string") ||
    (redact.remove !== undefined && typeof redact.remove !== "boolean")
  ) {
    return mandatoryOptions;
  }

  const paths = mergePaths(redact.paths);

  if (redact.remove === true) {
    return { paths, remove: true };
  }

  return {
    paths,
    censor: redact.censor ?? redactedValue,
  };
}

export function safePathname(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "/";
  }

  try {
    return new URL(rawUrl, "http://localhost").pathname || "/";
  } catch {
    const separatorIndex = rawUrl.search(/[?#]/u);
    const candidate = separatorIndex >= 0 ? rawUrl.slice(0, separatorIndex) : rawUrl;
    return candidate.startsWith("/") ? candidate : "/";
  }
}

export function safeErrorName(error: unknown): string {
  if (error instanceof AggregateError) {
    return "AggregateError";
  }
  if (error instanceof TypeError) {
    return "TypeError";
  }
  if (error instanceof RangeError) {
    return "RangeError";
  }
  if (error instanceof ReferenceError) {
    return "ReferenceError";
  }
  if (error instanceof SyntaxError) {
    return "SyntaxError";
  }
  if (error instanceof URIError) {
    return "URIError";
  }
  if (error instanceof EvalError) {
    return "EvalError";
  }

  return error instanceof Error ? "Error" : "UnknownError";
}

function safeRequestFields(request: FastifyRequest) {
  return {
    requestId: request.id,
    method: request.method,
    pathname: safePathname(request.raw.url),
  };
}

function safeErrorFields(
  error: unknown,
  request: FastifyRequest,
  statusCode: number,
) {
  return {
    ...safeRequestFields(request),
    statusCode,
    errorName: safeErrorName(error),
  };
}

export function secureLoggerOptions(
  logger: FastifyServerOptions["logger"] | undefined,
  serviceName: string,
): Exclude<FastifyServerOptions["logger"], undefined> {
  if (logger === false) {
    return false;
  }

  const overrides = typeof logger === "object" ? logger : {};

  return {
    ...overrides,
    level: overrides.level ?? process.env.LOG_LEVEL ?? "info",
    base: overrides.base ?? { service: serviceName },
    redact: mergedRedactOptions(overrides.redact),
    serializers: {
      ...overrides.serializers,
      req: (request: FastifyRequest) => ({
        method: request.method,
        pathname: safePathname(request.raw.url),
      }),
      err: (error) => ({
        type: safeErrorName(error),
        message: redactedValue,
        stack: redactedValue,
      }),
      res: (response) => ({ statusCode: response.statusCode }),
    },
  };
}

export class SafeLogController extends LogController {
  override incomingRequest(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    request.log.info(
      { event: "request_started", ...safeRequestFields(request) },
      "Request started",
    );
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    const completionFields = {
      event: error ? "request_failed" : "request_completed",
      ...safeRequestFields(request),
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime,
    };

    if (error) {
      reply.log.error(
        { ...completionFields, errorName: safeErrorName(error) },
        "Request failed",
      );
      return;
    }

    reply.log.info(completionFields, "Request completed");
  }

  override defaultErrorLog(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    const fields = {
      event: "request_error",
      ...safeErrorFields(error, request, reply.statusCode),
    };

    if (reply.statusCode >= 500) {
      reply.log.error(fields, "Request error");
    } else {
      reply.log.info(fields, "Request rejected");
    }
  }

  override streamError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    reply.log.warn(
      {
        event: "response_stream_error",
        ...safeErrorFields(error, request, reply.statusCode),
      },
      "Response stream failed",
    );
  }

  override routeNotFound(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    request.log.info(
      { event: "route_not_found", ...safeRequestFields(request), statusCode: 404 },
      "Route not found",
    );
  }

  override writeHeadError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    reply.log.warn(
      {
        event: "response_header_error",
        ...safeErrorFields(error, request, reply.statusCode),
      },
      "Response headers failed",
    );
  }

  override serializerError(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
    metadata: { statusCode: number },
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    reply.log.error(
      {
        event: "response_serializer_error",
        ...safeErrorFields(error, request, metadata.statusCode),
      },
      "Response serialization failed",
    );
  }

  override serviceUnavailable(logger: FastifyBaseLogger): void {
    logger.info(
      { event: "service_unavailable", statusCode: 503 },
      "Request refused while server is closing",
    );
  }
}
