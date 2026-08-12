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
export type JsonObject = { [key: string]: JsonValue };

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

export interface IdempotentCommandContext {
  idempotencyKey: string;
  requestDigest: string;
  transaction: QueryExecutor;
}

export type CommandUnitOfWork = <Result>(run: (
  transaction: QueryExecutor,
) => Promise<Result>) => Promise<Result>;

interface ExecuteIdempotentCommandOptions<Command extends string,
  Result extends Record<string, unknown>> {
  actorScope: string;
  command: Command;
  fenceCheck: typeof requireWriterFence;
  fenceResource: string;
  missingIdempotencyKeyIsInvalid?: boolean;
  payload: JsonValue;
  request: FastifyRequest;
  responseStatus?: number | ((result: Result) => number);
  run: (context: IdempotentCommandContext) => Promise<Result>;
  unitOfWork: CommandUnitOfWork;
  validateResponseStatus?: boolean;
  verifyOnlyStringDigestHeaders?: boolean;
}

export interface IdempotentCommandResponse<Command extends string,
  Result extends Record<string, unknown>> {
  command: {
    command: Command;
    idempotencyKey: string;
    requestDigest: string;
    replayed: boolean;
  };
  result: Result;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PlatformError(400, "BAD_REQUEST", "Invalid command payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export function canonicalRequestDigest(command: string, payload: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJson({ command, payload }), "utf8")
    .digest("hex");
}

function commandIdempotencyKey(request: FastifyRequest, missingIsInvalid: boolean): string {
  const value = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof value !== "string") {
    const message = missingIsInvalid
      ? "Invalid idempotency key"
      : `Missing ${IDEMPOTENCY_KEY_HEADER} header`;
    throw new PlatformError(400, "BAD_REQUEST", message);
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid idempotency key");
  }
  return value;
}

export function readIdempotencyKey(request: FastifyRequest): string {
  return commandIdempotencyKey(request, false);
}

function verifyClientDigest(request: FastifyRequest, digest: string,
  onlyWhenString: boolean): void {
  const supplied = request.headers[REQUEST_DIGEST_HEADER];
  if (supplied === undefined || (onlyWhenString && typeof supplied !== "string")) {
    return;
  }
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

export async function requireWriterFence(transaction: QueryExecutor,
  requirement: WriterFenceRequirement): Promise<void> {
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
    throw new PlatformError(503, "WRITER_FENCE_REJECTED", "Write owner is not active");
  }
}

function outcomeUnknown(statusCode: 409 | 503): PlatformError {
  return new PlatformError(statusCode, "COMMAND_OUTCOME_UNKNOWN",
    "Command outcome requires reconciliation");
}

function parseReplay<Result extends Record<string, unknown>>(row: IdempotencyRow): Result {
  if (row.responseJson === null || row.responseStatus === null) {
    throw outcomeUnknown(409);
  }
  try {
    const parsed: unknown = JSON.parse(row.responseJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid replay");
    }
    return parsed as Result;
  } catch {
    throw outcomeUnknown(503);
  }
}

function resolvedResponseStatus<Result extends Record<string, unknown>>(
  configured: number | ((result: Result) => number) | undefined,
  result: Result, validate: boolean): number {
  const status = typeof configured === "function"
    ? configured(result)
    : (configured ?? 200);
  if (validate && (!Number.isInteger(status) || status < 200 || status > 299)) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Invalid command response status");
  }
  return status;
}

export async function executeIdempotentCommand<Command extends string,
  Result extends Record<string, unknown>>(
  options: ExecuteIdempotentCommandOptions<Command, Result>): Promise<{
  body: IdempotentCommandResponse<Command, Result>;
  statusCode: number;
}> {
  const idempotencyKey = commandIdempotencyKey(options.request,
    options.missingIdempotencyKeyIsInvalid ?? false);
  const requestDigest = canonicalRequestDigest(options.command, options.payload);
  verifyClientDigest(options.request, requestDigest,
    options.verifyOnlyStringDigestHeaders ?? false);
  const defaultResponseStatus = typeof options.responseStatus === "number"
    ? options.responseStatus
    : 200;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

  try {
    const outcome = await options.unitOfWork(async (transaction) => {
      await options.fenceCheck(transaction, {
        generation: WRITER_FENCE_GENERATION,
        owner: WRITER_OWNER,
        resource: options.fenceResource,
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
        throw outcomeUnknown(503);
      }
      if (row.requestDigest !== requestDigest) {
        throw new PlatformError(409, "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key was used for another request");
      }
      if (inserted.affectedRows === 0) {
        if (row.status === "completed") {
          return {
            replayed: true as const,
            result: parseReplay<Result>(row),
            statusCode: row.responseStatus ?? defaultResponseStatus,
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

      const result = await options.run({ idempotencyKey, requestDigest, transaction });
      const responseStatus = resolvedResponseStatus(options.responseStatus, result,
        options.validateResponseStatus ?? false);
      const completed = await transaction.execute(
        `UPDATE command_idempotency
         SET status = 'completed', response_status = ?, response_json = ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE command_name = ? AND actor_scope = ? AND idempotency_key = ?
           AND request_digest = ? AND status = 'pending'`,
        [responseStatus, JSON.stringify(result), options.command, options.actorScope,
          idempotencyKey, requestDigest],
      );
      if (completed.affectedRows !== 1) {
        throw outcomeUnknown(409);
      }
      return { replayed: false as const, result, statusCode: responseStatus };
    });

    return {
      statusCode: outcome.statusCode,
      body: { command: { command: options.command, idempotencyKey, requestDigest,
        replayed: outcome.replayed }, result: outcome.result },
    };
  } catch (error) {
    if (
      error instanceof DatabaseClientError &&
      error.code === "DATABASE_TRANSACTION_OUTCOME_UNKNOWN"
    ) {
      throw new PlatformError(503, "COMMAND_OUTCOME_UNKNOWN",
        "Command outcome is unknown; retry only with the same idempotency key");
    }
    throw error;
  }
}

export async function executeCommand<Result extends Record<string, unknown>>(
  options: ExecuteCommandOptions<Result>,
): Promise<{ body: CommandResponse<Result>; statusCode: number }> {
  return executeIdempotentCommand({
    actorScope: options.actorScope,
    command: options.command,
    fenceCheck: requireWriterFence,
    fenceResource: COMMAND_WRITER_RESOURCES[options.command],
    payload: options.payload,
    request: options.request,
    ...(options.responseStatus === undefined
      ? {}
      : { responseStatus: options.responseStatus }),
    run: ({ transaction }) => options.run({ audit: transaction, transaction }),
    unitOfWork: options.database.transaction,
  });
}
