import { createHash } from "node:crypto";

import type {
  R2CommandName,
  R2CommandResponse,
} from "@topology/contracts/r2-writes";
import type { FastifyRequest } from "fastify";

import { PlatformError } from "../../errors.js";
import {
  DatabaseClientError,
  type QueryExecutor,
} from "../../infrastructure/database.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const DIGEST_PATTERN = /^[a-f\d]{64}$/u;
const FENCE_OWNER = "fastify-v1";
const FENCE_GENERATION = 2;

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface IdempotencyRow extends Record<string, unknown> {
  requestDigest: string;
  responseJson: string | null;
  responseStatus: number | null;
  status: string;
}

export function r2FenceResource(command: R2CommandName): string {
  return `r2.${command}`;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PlatformError(400, "BAD_REQUEST", "Invalid command payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`).join(",")}}`;
}

export function r2RequestDigest(command: R2CommandName, payload: JsonValue): string {
  return createHash("sha256")
    .update(canonical({ command, payload }), "utf8")
    .digest("hex");
}

function requiredKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid idempotency key");
  }
  return value;
}

function verifyDigest(request: FastifyRequest, digest: string): void {
  const supplied = request.headers["x-request-digest"];
  if (supplied === undefined) return;
  if (typeof supplied !== "string" || !DIGEST_PATTERN.test(supplied.toLowerCase()) || supplied.toLowerCase() !== digest) {
    throw new PlatformError(400, "BAD_REQUEST", "Request digest mismatch");
  }
}

function replay<Result extends Record<string, unknown>>(row: IdempotencyRow): Result {
  if (row.responseJson === null || row.responseStatus === null) {
    throw new PlatformError(409, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
  }
  try {
    const parsed: unknown = JSON.parse(row.responseJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid replay");
    return parsed as Result;
  } catch {
    throw new PlatformError(503, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
  }
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
  const idempotencyKey = requiredKey(options.request);
  const requestDigest = r2RequestDigest(options.command, options.payload);
  verifyDigest(options.request, requestDigest);
  const defaultResponseStatus = typeof options.responseStatus === "number" ? options.responseStatus : 200;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  try {
    const outcome = await options.context.unitOfWork(async (transaction) => {
      await options.context.requireWriterFence(transaction, {
        generation: FENCE_GENERATION,
        owner: FENCE_OWNER,
        resource: r2FenceResource(options.command),
      });
      const inserted = await transaction.execute(
        `INSERT IGNORE INTO command_idempotency (
           command_name, actor_scope, idempotency_key, request_digest,
           status, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [options.command, options.actorScope, idempotencyKey, requestDigest, expiresAt],
      );
      const rows = await transaction.query<IdempotencyRow>(
        `SELECT request_digest AS requestDigest, status,
                response_status AS responseStatus, response_json AS responseJson
         FROM command_idempotency
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [options.command, options.actorScope, idempotencyKey],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new PlatformError(503, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
      }
      if (row.requestDigest !== requestDigest) {
        throw new PlatformError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was used for another request");
      }
      if (inserted.affectedRows === 0) {
        if (row.status === "completed") {
          return { replayed: true as const, result: replay<Result>(row), statusCode: row.responseStatus ?? defaultResponseStatus };
        }
        throw new PlatformError(
          409,
          row.status === "unknown" ? "COMMAND_OUTCOME_UNKNOWN" : "COMMAND_IN_PROGRESS",
          row.status === "unknown" ? "Command outcome requires reconciliation" : "Command is already in progress",
        );
      }

      const result = await options.run({ idempotencyKey, requestDigest, transaction });
      const responseStatus = typeof options.responseStatus === "function"
        ? options.responseStatus(result)
        : defaultResponseStatus;
      if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus > 299) {
        throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Invalid command response status");
      }
      const completed = await transaction.execute(
        `UPDATE command_idempotency
         SET status = 'completed', response_status = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
           AND request_digest = ? AND status = 'pending'`,
        [responseStatus, JSON.stringify(result), options.command, options.actorScope, idempotencyKey, requestDigest],
      );
      if (completed.affectedRows !== 1) {
        throw new PlatformError(409, "COMMAND_OUTCOME_UNKNOWN", "Command outcome requires reconciliation");
      }
      return { replayed: false as const, result, statusCode: responseStatus };
    });

    return {
      statusCode: outcome.statusCode,
      body: {
        command: { command: options.command, idempotencyKey, requestDigest, replayed: outcome.replayed },
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
