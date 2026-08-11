import { randomUUID } from "node:crypto";

import swagger from "@fastify/swagger";
import {
  apiErrorResponseSchema,
  apiErrorSchemaId,
  healthLiveResponseSchema,
  healthLiveSchemaId,
  healthReadyResponseSchema,
  healthReadySchemaId,
  type HealthLiveResponse,
  type HealthReadyCheck,
  type HealthReadyResponse,
} from "@topology/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { createApiErrorResponse, createErrorResponse } from "./errors.js";
import {
  SafeLogController,
  safeErrorName,
  secureLoggerOptions,
} from "./safe-logging.js";

const defaultServiceName = "topology-api";
const defaultReadinessTimeoutMs = 2_000;
const requestIdHeader = "x-request-id";

export interface ReadinessCheck {
  name: string;
  run: () => Promise<void> | void;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  readinessChecks?: readonly ReadinessCheck[];
  readinessTimeoutMs?: number;
  serviceName?: string;
}

function resolveReadinessTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? defaultReadinessTimeoutMs;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("readinessTimeoutMs must be a positive safe integer");
  }

  return timeoutMs;
}

function normalizeStatusCode(error: unknown): number {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? error.statusCode
      : undefined;

  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
  ) {
    return statusCode;
  }

  return 500;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const serviceName = options.serviceName?.trim() || defaultServiceName;
  const readinessChecks = options.readinessChecks ?? [];
  const readinessTimeoutMs = resolveReadinessTimeoutMs(
    options.readinessTimeoutMs,
  );
  const app = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader,
    logger: secureLoggerOptions(options.logger, serviceName),
    logController: new SafeLogController(),
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Topology Supply Chain API",
        version: "0.1.0",
      },
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json.$id === "string" ? json.$id : `schema-${index}`,
    },
  });

  app.addSchema(apiErrorResponseSchema);
  app.addSchema(healthLiveResponseSchema);
  app.addSchema(healthReadyResponseSchema);

  app.addHook("onRequest", (request, reply, done) => {
    reply.header(requestIdHeader, request.id);
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(createApiErrorResponse(404, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = normalizeStatusCode(error);
    const fields = {
      event: statusCode >= 500 ? "unhandled_request_error" : "request_rejected",
      requestId: request.id,
      statusCode,
      errorName: safeErrorName(error),
    };

    if (statusCode >= 500) {
      request.log.error(fields, "Unhandled request error");
    } else {
      request.log.info(fields, "Request rejected");
    }

    void reply
      .status(statusCode)
      .send(createErrorResponse(error, statusCode, request.id));
  });

  app.get<{ Reply: HealthLiveResponse }>(
    "/api/v1/health/live",
    {
      schema: {
        tags: ["health"],
        summary: "Process liveness",
        response: {
          200: { $ref: `${healthLiveSchemaId}#` },
          "4xx": { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async () => ({
      status: "ok",
      service: serviceName,
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    }),
  );

  app.get<{ Reply: HealthReadyResponse }>(
    "/api/v1/health/ready",
    {
      schema: {
        tags: ["health"],
        summary: "Dependency readiness",
        response: {
          200: { $ref: `${healthReadySchemaId}#` },
          503: { $ref: `${healthReadySchemaId}#` },
          "4xx": { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      const checks: HealthReadyCheck[] = await Promise.all(
        readinessChecks.map(async (check) => {
          let timeout: ReturnType<typeof setTimeout> | undefined;

          try {
            const result = await Promise.race([
              Promise.resolve()
                .then(() => check.run())
                .then(() => "passed" as const),
              new Promise<"timed_out">((resolve) => {
                timeout = setTimeout(
                  () => resolve("timed_out"),
                  readinessTimeoutMs,
                );
              }),
            ]);

            if (result === "timed_out") {
              request.log.warn(
                {
                  event: "readiness_check_failed",
                  readinessCheck: check.name,
                  timedOut: true,
                  timeoutMs: readinessTimeoutMs,
                },
                "Readiness check failed",
              );
              return { name: check.name, status: "failed" } as const;
            }

            return { name: check.name, status: "ok" } as const;
          } catch {
            request.log.warn(
              {
                event: "readiness_check_failed",
                readinessCheck: check.name,
                timedOut: false,
              },
              "Readiness check failed",
            );
            return { name: check.name, status: "failed" } as const;
          } finally {
            if (timeout !== undefined) {
              clearTimeout(timeout);
            }
          }
        }),
      );
      const ready = checks.every((check) => check.status === "ok");
      const body: HealthReadyResponse = {
        status: ready ? "ok" : "not_ready",
        service: serviceName,
        timestamp: new Date().toISOString(),
        checks,
      };

      return reply.status(ready ? 200 : 503).send(body);
    },
  );

  return app;
}
