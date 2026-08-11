import {
  R3_COMMAND_RESOURCES,
  type R3CommandName,
} from "@topology/contracts/r3-fulfillment-writes";
import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
import {
  DatabaseClientError,
  type QueryExecutor,
} from "../infrastructure/database.js";
import type { AccessContext } from "../modules/auth/index.js";
import {
  canonicalRequestDigest,
  readIdempotencyKey,
} from "../platform/commands.js";
import type { DomainRegistrationContext } from "../platform/registrations.js";
import { requireCsrf, requireSameOrigin } from "../platform/security.js";

type Json = boolean | null | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface IdempotencyRow extends Record<string, unknown> {
  requestDigest: string;
  responseJson: string | null;
  responseStatus: number | null;
  status: string;
}

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
  // User ids are tenant-local authoritative identities in this deployment.
  // Sessions and role bindings rotate independently and must not turn the same
  // idempotency key into a new command identity.
  return `user:${access.userId}`;
}

function replay<Result extends Record<string, unknown>>(row: IdempotencyRow): Result {
  if (row.responseJson === null || row.responseStatus === null) {
    throw new PlatformError(409, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
  }
  try {
    const value: unknown = JSON.parse(row.responseJson);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid replay");
    return value as Result;
  } catch {
    throw new PlatformError(503, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
  }
}

export async function executeR3Command<Result extends Record<string, unknown>>(
  options: R3CommandOptions<Result>,
): Promise<{ body: Record<string, unknown>; statusCode: number }> {
  requireSameOrigin(options.request);
  requireCsrf(options.request);
  if (options.context.database === undefined) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Database unavailable");
  }
  const access = await options.context.authenticate(options.request);
  const scope = actorScope(access);
  const key = readIdempotencyKey(options.request);
  const digest = canonicalRequestDigest(options.command as never, options.payload as never);
  const suppliedDigest = options.request.headers["x-request-digest"];
  if (typeof suppliedDigest === "string" && suppliedDigest.toLowerCase() !== digest) {
    throw new PlatformError(400, "BAD_REQUEST", "Request digest mismatch");
  }
  const responseStatus = options.responseStatus ?? 200;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  try {
    const outcome = await options.context.unitOfWork(async (transaction) => {
      await options.context.requireWriterFence(transaction, {
        generation: 2,
        owner: "fastify-v1",
        resource: R3_COMMAND_RESOURCES[options.command],
      });
      const inserted = await transaction.execute(
        `INSERT IGNORE INTO command_idempotency (
           command_name, actor_scope, idempotency_key, request_digest,
           status, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [options.command, scope, key, digest, expiresAt],
      );
      const rows = await transaction.query<IdempotencyRow>(
        `SELECT request_digest AS requestDigest, status,
                response_status AS responseStatus, response_json AS responseJson
         FROM command_idempotency
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [options.command, scope, key],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new PlatformError(503, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
      }
      if (row.requestDigest !== digest) {
        throw new PlatformError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was used for another request");
      }
      if (inserted.affectedRows === 0) {
        if (row.status === "completed") {
          return { result: replay<Result>(row), replayed: true, statusCode: row.responseStatus ?? responseStatus };
        }
        throw new PlatformError(
          409,
          row.status === "unknown" ? "COMMAND_OUTCOME_UNKNOWN" : "COMMAND_IN_PROGRESS",
          row.status === "unknown" ? "Command outcome requires reconciliation" : "Command is already in progress",
        );
      }
      const result = await options.run({ access, request: options.request, transaction });
      const completed = await transaction.execute(
        `UPDATE command_idempotency
         SET status = 'completed', response_status = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
           AND request_digest = ? AND status = 'pending'`,
        [responseStatus, JSON.stringify(result), options.command, scope, key, digest],
      );
      if (completed.affectedRows !== 1) {
        throw new PlatformError(409, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
      }
      return { result, replayed: false, statusCode: responseStatus };
    });
    return {
      statusCode: outcome.statusCode,
      body: {
        command: { command: options.command, idempotencyKey: key, requestDigest: digest, replayed: outcome.replayed },
        result: outcome.result,
      },
    };
  } catch (error) {
    if (error instanceof DatabaseClientError && error.code === "DATABASE_TRANSACTION_OUTCOME_UNKNOWN") {
      throw new PlatformError(
        503,
        "COMMAND_OUTCOME_UNKNOWN",
        "Command outcome is unknown; retry only with the same idempotency key",
      );
    }
    throw error;
  }
}
