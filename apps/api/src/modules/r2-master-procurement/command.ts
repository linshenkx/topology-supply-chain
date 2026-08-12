import type { R2CommandName, R2CommandResponse } from "@topology/contracts/r2-writes";
import type { FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type JsonValue,
} from "../../platform/commands.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";

export function r2FenceResource(command: R2CommandName): string {
  return `r2.${command}`;
}

export function r2RequestDigest(command: R2CommandName, payload: JsonValue): string {
  return canonicalRequestDigest(command, payload);
}

export interface R2CommandRunContext {
  idempotencyKey: string;
  requestDigest: string;
  transaction: QueryExecutor;
}

export interface ExecuteR2CommandOptions<Result extends Record<string, unknown>> {
  actorScope: string;
  command: R2CommandName;
  context: DomainRegistrationContext;
  payload: JsonValue;
  request: FastifyRequest;
  responseStatus?: number | ((result: Result) => number);
  run: (context: R2CommandRunContext) => Promise<Result>;
}

export async function executeR2Command<Result extends Record<string, unknown>>(
  options: ExecuteR2CommandOptions<Result>,
): Promise<{ body: R2CommandResponse<Result>; statusCode: number }> {
  return executeIdempotentCommand({
    ...options,
    fenceCheck: options.context.requireWriterFence,
    fenceResource: r2FenceResource(options.command),
    missingIdempotencyKeyIsInvalid: true,
    unitOfWork: options.context.unitOfWork,
    validateResponseStatus: true,
  });
}
