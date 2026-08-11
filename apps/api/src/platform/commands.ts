import { createHash } from "node:crypto";

import {
  type CommandResponse,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_DIGEST_HEADER,
  type PlatformCommandName,
} from "@topology/contracts";
import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
import {
  DatabaseClientError,
  type DatabaseClient,
  type QueryExecutor,
} from "../infrastructure/database.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/u;
export const WRITER_FENCE_GENERATION = 2;
const WRITER_OWNER = "fastify-v1";

export const COMMAND_WRITER_RESOURCES: Readonly<
  Record<PlatformCommandName, string>
> = Object.freeze({
  "auth.login": "auth.commands",
  "auth.logout": "auth.commands",
  "auth.verify": "auth.commands",
  "step-up.request": "auth.commands",
  "step-up.verify": "auth.commands",
  "files.upload": "files.commands",
  "notifications.mark-read": "notifications.commands",
  "users.assign-role": "users.commands",
  "users.revoke-role": "users.commands",
  "users.unlock": "users.commands",
});

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface IdempotencyRow extends Record<string, unknown> {
  requestDigest: string;
  responseJson: string | null;
  responseStatus: number | null;
  status: string;
}

interface WriterFenceRow extends Record<string, unknown> {
  enabled: number | boolean;
  generation: number;
  owner: string;
}

export interface CommandRunContext {
  audit: QueryExecutor;
  transaction: QueryExecutor;
}

export interface ExecuteCommandOptions<Result extends Record<string, unknown>> {
  actorScope: string;
  command: PlatformCommandName;
  database: DatabaseClient;
  payload: JsonValue;
  request: FastifyRequest;
  responseStatus?: number;
  run: (context: CommandRunContext) => Promise<Result>;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PlatformError(400, "BAD_REQUEST", "Invalid command payload");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export function canonicalRequestDigest(
  command: PlatformCommandName,
  payload: JsonValue,
): string {
  return createHash("sha256")
    .update(canonicalJson({ command, payload }), "utf8")
    .digest("hex");
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") {
    throw new PlatformError(400, "BAD_REQUEST", `Missing ${name} header`);
  }
  return value;
}

export function readIdempotencyKey(request: FastifyRequest): string {
  const value = requiredHeader(request, IDEMPOTENCY_KEY_HEADER);
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid idempotency key");
  }
  return value;
}

function verifyClientDigest(request: FastifyRequest, digest: string): void {
  const supplied = request.headers[REQUEST_DIGEST_HEADER];
  if (supplied === undefined) return;
  if (
    typeof supplied !== "string" ||
    !SHA256_PATTERN.test(supplied.toLowerCase()) ||
    supplied.toLowerCase() !== digest
  ) {
    throw new PlatformError(400, "BAD_REQUEST", "Request digest mismatch");
  }
}

export interface WriterFenceRequirement {
  generation: number;
  owner: string;
  resource: string;
}

export async function requireWriterFence(
  transaction: QueryExecutor,
  requirement: WriterFenceRequirement,
): Promise<void> {
  const rows = await transaction.query<WriterFenceRow>(
    `SELECT owner, enabled, generation
     FROM writer_fences
     WHERE resource = ?
     LIMIT 1
     FOR SHARE`,
    [requirement.resource],
  );
  const row = rows[0];
  if (
    row === undefined ||
    row.owner !== requirement.owner ||
    row.generation !== requirement.generation ||
    !(row.enabled === true || row.enabled === 1)
  ) {
    throw new PlatformError(
      503,
      "WRITER_FENCE_REJECTED",
      "Write owner is not active",
    );
  }
}

function parseReplay<Result extends Record<string, unknown>>(
  row: IdempotencyRow,
): Result {
  if (row.responseJson === null || row.responseStatus === null) {
    throw new PlatformError(
      409,
      "COMMAND_OUTCOME_UNKNOWN",
      "Command outcome requires reconciliation",
    );
  }
  try {
    const parsed: unknown = JSON.parse(row.responseJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid replay");
    }
    return parsed as Result;
  } catch {
    throw new PlatformError(
      503,
      "COMMAND_OUTCOME_UNKNOWN",
      "Command outcome requires reconciliation",
    );
  }
}

export async function executeCommand<Result extends Record<string, unknown>>(
  options: ExecuteCommandOptions<Result>,
): Promise<{ body: CommandResponse<Result>; statusCode: number }> {
  const key = readIdempotencyKey(options.request);
  const digest = canonicalRequestDigest(options.command, options.payload);
  verifyClientDigest(options.request, digest);
  const responseStatus = options.responseStatus ?? 200;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  try {
    const outcome = await options.database.transaction(async (transaction) => {
      await requireWriterFence(transaction, {
        generation: WRITER_FENCE_GENERATION,
        owner: WRITER_OWNER,
        resource: COMMAND_WRITER_RESOURCES[options.command]!,
      });
      const inserted = await transaction.execute(
        `INSERT IGNORE INTO command_idempotency (
           command_name, actor_scope, idempotency_key, request_digest,
           status, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [options.command, options.actorScope, key, digest, expiresAt],
      );
      const rows = await transaction.query<IdempotencyRow>(
        `SELECT
           request_digest AS requestDigest,
           status,
           response_status AS responseStatus,
           response_json AS responseJson
         FROM command_idempotency
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
         LIMIT 1
         FOR UPDATE`,
        [options.command, options.actorScope, key],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new PlatformError(
          503,
          "COMMAND_OUTCOME_UNKNOWN",
          "Command outcome requires reconciliation",
        );
      }
      if (row.requestDigest !== digest) {
        throw new PlatformError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key was used for another request",
        );
      }
      if (inserted.affectedRows === 0) {
        if (row.status === "completed") {
          return {
            replayed: true as const,
            result: parseReplay<Result>(row),
            statusCode: row.responseStatus ?? responseStatus,
          };
        }
        throw new PlatformError(
          409,
          row.status === "unknown"
            ? "COMMAND_OUTCOME_UNKNOWN"
            : "COMMAND_IN_PROGRESS",
          row.status === "unknown"
            ? "Command outcome requires reconciliation"
            : "Command is already in progress",
        );
      }

      const result = await options.run({ audit: transaction, transaction });
      const serialized = JSON.stringify(result);
      const completed = await transaction.execute(
        `UPDATE command_idempotency
         SET status = 'completed', response_status = ?, response_json = ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
           AND request_digest = ? AND status = 'pending'`,
        [
          responseStatus,
          serialized,
          options.command,
          options.actorScope,
          key,
          digest,
        ],
      );
      if (completed.affectedRows !== 1) {
        throw new PlatformError(
          409,
          "COMMAND_OUTCOME_UNKNOWN",
          "Command outcome requires reconciliation",
        );
      }
      return { replayed: false as const, result, statusCode: responseStatus };
    });

    return {
      statusCode: outcome.statusCode,
      body: {
        command: {
          command: options.command,
          idempotencyKey: key,
          requestDigest: digest,
          replayed: outcome.replayed,
        },
        result: outcome.result,
      },
    };
  } catch (error) {
    if (
      error instanceof DatabaseClientError &&
      error.code === "DATABASE_TRANSACTION_OUTCOME_UNKNOWN"
    ) {
      throw new PlatformError(
        503,
        "COMMAND_OUTCOME_UNKNOWN",
        "Command outcome is unknown; retry only with the same idempotency key",
      );
    }
    throw error;
  }
}
