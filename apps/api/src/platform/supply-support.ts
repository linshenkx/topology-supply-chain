import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
import { createAuditWriter } from "../infrastructure/audit.js";
import type { QueryExecutor } from "../infrastructure/database.js";
import type { AccessContext } from "../modules/auth/index.js";
import type { DomainRegistrationContext } from "./registrations.js";

export type DataRow = Record<string, unknown>;

const INTERNAL_ROLES = new Set(["admin", "supply_chain"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function bad(message: string): never {
  throw new PlatformError(400, "BAD_REQUEST", message);
}

export function conflict(message: string): never {
  throw new PlatformError(409, "CONFLICT", message);
}

export function forbidden(message = "Forbidden"): never {
  throw new PlatformError(403, "FORBIDDEN", message);
}

export function missing(message: string): never {
  throw new PlatformError(404, "NOT_FOUND", message);
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("JSON object required");
  return value as Record<string, unknown>;
}

export function text(value: unknown, maximum = 1_000): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length === 0 || result.length > maximum) return bad("Invalid text field");
  return result;
}

export function optionalText(value: unknown, maximum = 1_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, maximum);
}

export function positiveInteger(value: unknown, message = "Positive integer required"): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) return bad(message);
  return result;
}

export function nonNegativeInteger(value: unknown, message = "Non-negative integer required"): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) return bad(message);
  return result;
}

export function date(value: unknown, message = "Valid date required"): string {
  const result = text(value, 10);
  if (!DATE_PATTERN.test(result)) return bad(message);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) return bad(message);
  return result;
}

export function jsonValue(value: unknown): import("./commands.js").JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return bad("Invalid JSON payload");
    return JSON.parse(serialized) as import("./commands.js").JsonValue;
  } catch {
    return bad("Invalid JSON payload");
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return bad("Invalid JSON payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") return bad("Invalid JSON payload");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key] ?? null)}`).join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function isInternal(access: AccessContext): boolean {
  return access.roles.some((role) => INTERNAL_ROLES.has(role));
}

export function requireRoles(access: AccessContext, roles: readonly string[]): void {
  if (!access.roles.some((role) => roles.includes(role))) return forbidden();
}

export function requireLiveSession(access: AccessContext): void {
  if (access.localPreview || access.sessionId === null || access.userId <= 0) {
    return forbidden("Authenticated session required");
  }
}

export function requireFactoryBinding(access: AccessContext, factoryId: number): void {
  if (!access.roles.includes("factory") || access.factoryId === null || access.factoryId !== factoryId) {
    return forbidden("Factory role and binding are required");
  }
}

export async function insertId(
  transaction: QueryExecutor,
  sql: string,
  parameters: readonly unknown[],
): Promise<number> {
  const result = await transaction.execute(sql, parameters as never[]);
  if (result.affectedRows !== 1 || result.insertId === undefined || result.insertId <= 0) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Write failed");
  }
  return result.insertId;
}

export async function one<Row extends DataRow>(
  transaction: QueryExecutor,
  sql: string,
  parameters: readonly unknown[],
  message: string,
): Promise<Row> {
  const rows = await transaction.query<Row>(sql, parameters as never[]);
  const row = rows[0];
  if (row === undefined) return missing(message);
  return row;
}

export function requestNo(prefix: string, idempotencyKey: string, discriminator = ""): string {
  const suffix = createHash("sha256").update(`${idempotencyKey}:${discriminator}`, "utf8").digest("hex").slice(0, 24);
  return `${prefix}-${suffix}`;
}

export async function audit(
  transaction: QueryExecutor,
  request: FastifyRequest,
  access: AccessContext,
  event: {
    action: string;
    after?: unknown;
    before?: unknown;
    businessNo?: string;
    entityId: number | string;
    entityType: string;
    module: string;
  },
): Promise<void> {
  await createAuditWriter({ database: transaction })({ access, request, ...event });
}

export async function domainEvent(
  context: DomainRegistrationContext,
  transaction: QueryExecutor,
  input: {
    data?: Record<string, import("./commands.js").JsonValue>;
    entityId: number | string;
    entityType: string;
    eventType: string;
    idempotencyKey: string;
    recipient:
      | { kind: "entity_binding"; role: "factory"; entityId: number | string; entityType: string }
      | { kind: "role"; role: "supply_chain" }
      | { kind: "user"; userId: number };
  },
): Promise<void> {
  const entityId = String(input.entityId);
  const recipient = input.recipient.kind === "entity_binding"
    ? { ...input.recipient, entityId: String(input.recipient.entityId) }
    : input.recipient;
  const enqueueDomainEvent = context.enqueueOutbox as unknown as (
    tx: QueryExecutor,
    message: {
      aggregateId: string;
      aggregateType: string;
      deduplicationKey: string;
      payload: import("./commands.js").JsonValue;
      topic: "domain.event";
    },
  ) => Promise<void>;
  await enqueueDomainEvent(transaction, {
    topic: "domain.event",
    aggregateType: input.entityType,
    aggregateId: entityId,
    deduplicationKey: `r2:${input.eventType}:${input.entityType}:${entityId}:${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`,
    payload: {
      schemaVersion: 1,
      entityType: input.entityType,
      entityId,
      eventType: input.eventType,
      recipient,
      data: input.data ?? {},
    },
  });
}

export function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function expectedTimestamp(value: unknown): string {
  const timestamp = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z)?$/u.test(timestamp)) return bad("Expected resource timestamp required");
  return timestamp;
}
