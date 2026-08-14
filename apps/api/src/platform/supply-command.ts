import type { SupplyCommandName, SupplyCommandResponse } from "@topology/contracts/supply-writes";
import type { FastifyRequest } from "fastify";

import type { QueryExecutor } from "../infrastructure/database.js";
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type JsonValue,
} from "./commands.js";
import type { DomainRegistrationContext } from "./registrations.js";

export function supplyFenceResource(command: SupplyCommandName): string {
  return `r2.${command}`;
}

export function supplyRequestDigest(command: SupplyCommandName, payload: JsonValue): string {
  return canonicalRequestDigest(command, payload);
}

export interface SupplyCommandRunContext {
  idempotencyKey: string;
  requestDigest: string;
  transaction: QueryExecutor;
}

export interface ExecuteSupplyCommandOptions<Result extends Record<string, unknown>> {
  actorScope: string;
  command: SupplyCommandName;
  context: DomainRegistrationContext;
  payload: JsonValue;
  request: FastifyRequest;
  responseStatus?: number | ((result: Result) => number);
  run: (context: SupplyCommandRunContext) => Promise<Result>;
}

export async function executeSupplyCommand<Result extends Record<string, unknown>>(
  options: ExecuteSupplyCommandOptions<Result>,
): Promise<{ body: SupplyCommandResponse<Result>; statusCode: number }> {
  return executeIdempotentCommand({
    ...options,
    fenceCheck: options.context.requireWriterFence,
    fenceResource: supplyFenceResource(options.command),
    missingIdempotencyKeyIsInvalid: true,
    unitOfWork: options.context.unitOfWork,
    validateResponseStatus: true,
  });
}
