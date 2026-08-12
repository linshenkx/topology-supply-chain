import { R3_COMMAND_RESOURCES, type R3CommandName } from "@topology/contracts/r3-fulfillment-writes";
import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
import type { QueryExecutor } from "../infrastructure/database.js";
import type { AccessContext } from "../modules/auth/index.js";
import { executeIdempotentCommand, type JsonObject } from "../platform/commands.js";
import type { DomainRegistrationContext } from "../platform/registrations.js";
import { requireCsrf, requireSameOrigin } from "../platform/security.js";

export interface R3CommandContext {
  access: AccessContext;
  request: FastifyRequest;
  transaction: QueryExecutor;
}

export interface R3CommandOptions<Result extends Record<string, unknown>> {
  command: R3CommandName;
  context: DomainRegistrationContext;
  payload: JsonObject;
  request: FastifyRequest;
  responseStatus?: number;
  run: (command: R3CommandContext) => Promise<Result>;
}

function actorScope(access: AccessContext): string {
  if (access.localPreview || access.sessionId === null || access.userId <= 0) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Write authentication unavailable");
  }
  // User ids are tenant-local authoritative identities. Session and role
  // rotation must not turn the same key into a different command identity.
  return `user:${access.userId}`;
}

export async function executeR3Command<Result extends Record<string, unknown>>(
  options: R3CommandOptions<Result>,
) {
  requireSameOrigin(options.request);
  requireCsrf(options.request);
  if (options.context.database === undefined) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Database unavailable");
  }
  const access = await options.context.authenticate(options.request);
  return executeIdempotentCommand({
    ...options,
    actorScope: actorScope(access),
    fenceCheck: options.context.requireWriterFence,
    fenceResource: R3_COMMAND_RESOURCES[options.command],
    run: ({ transaction }) => options.run({ access, request: options.request, transaction }),
    unitOfWork: options.context.unitOfWork,
    verifyOnlyStringDigestHeaders: true,
  });
}
