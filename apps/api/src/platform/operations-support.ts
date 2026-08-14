import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
import { createAuditWriter } from "../infrastructure/audit.js";
import type { QueryExecutor } from "../infrastructure/database.js";
import type { AccessContext } from "../modules/auth/index.js";
import type { JsonValue } from "./commands.js";
import type { DomainRegistrationContext } from "./registrations.js";

// mysql2 rows are runtime-validated at every domain boundary below. `any` is
// confined to this adapter because noUncheckedIndexedAccess otherwise adds
// `undefined` to every aliased SQL column and makes parameter forwarding
// impossible to express without unsafe casts at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export function integer(value: unknown, name: string, minimum = 1): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new PlatformError(400, "BAD_REQUEST", `Invalid ${name}`);
  }
  return result;
}

export function optionalInteger(value: unknown, name: string): number | null {
  return value === undefined || value === null || value === "" ? null : integer(value, name);
}

export function string(value: unknown, name: string, maximum = 1_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new PlatformError(400, "BAD_REQUEST", `Invalid ${name}`);
  }
  return value.trim();
}

export function optionalString(value: unknown, maximum = 2_000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid text value");
  }
  return value.trim();
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new PlatformError(400, "BAD_REQUEST", `Invalid ${name}`);
  }
  return value as T;
}

export function hasRole(access: AccessContext, roles: readonly string[]): boolean {
  return access.roles.some((role) => roles.includes(role));
}

export function requireRole(access: AccessContext, roles: readonly string[]): void {
  if (!hasRole(access, roles)) throw new PlatformError(403, "FORBIDDEN", "Forbidden scope");
}

export function internal(access: AccessContext): boolean {
  return hasRole(access, ["admin", "supply_chain", "finance", "company_qc"]);
}

export async function lockVersion(
  transaction: QueryExecutor,
  resourceType: string,
  resourceId: number | string,
): Promise<number> {
  await transaction.execute(
    `INSERT IGNORE INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES (?, ?, 1, CURRENT_TIMESTAMP(3))`,
    [resourceType, String(resourceId)],
  );
  const rows = await transaction.query<Row>(
    `SELECT version FROM resource_versions
     WHERE resource_type = ? AND resource_id = ? LIMIT 1 FOR UPDATE`,
    [resourceType, String(resourceId)],
  );
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PlatformError(409, "VERSION_CONFLICT", "Resource version unavailable");
  }
  return version;
}

export async function bumpVersion(
  transaction: QueryExecutor,
  resourceType: string,
  resourceId: number | string,
  version: number,
): Promise<number> {
  const result = await transaction.execute(
    `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
     WHERE resource_type = ? AND resource_id = ? AND version = ?`,
    [resourceType, String(resourceId), version],
  );
  if (result.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Resource version changed");
  return version + 1;
}

export async function audit(
  transaction: QueryExecutor,
  access: AccessContext,
  request: FastifyRequest,
  event: {
    action: string;
    module: string;
    entityType: string;
    entityId: number | string;
    businessNo?: string;
    before?: unknown;
    after?: unknown;
    sensitiveView?: boolean;
  },
): Promise<void> {
  await createAuditWriter({ database: transaction })({
    access,
    request,
    ...event,
  });
}

export async function domainEvent(
  context: DomainRegistrationContext,
  transaction: QueryExecutor,
  input: {
    type: string;
    aggregateType: string;
    aggregateId: number | string;
    deduplicationSuffix?: number | string;
    payload?: Record<string, JsonValue>;
    recipient?:
      | { kind: "role"; role: "supply_chain" }
      | { kind: "user"; userId: number };
  },
): Promise<void> {
  const suffix = input.deduplicationSuffix === undefined ? "" : `:${input.deduplicationSuffix}`;
  await context.enqueueOutbox(transaction, {
    topic: "domain.event",
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    deduplicationKey: `r3:${input.type}:${input.aggregateType}:${input.aggregateId}${suffix}`,
    payload: {
      schemaVersion: 1,
      entityType: input.aggregateType,
      entityId: String(input.aggregateId),
      eventType: input.type,
      recipient: input.recipient ?? { kind: "none" as const },
      data: input.payload ?? {},
    },
  });
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid request body");
  }
  return value as Record<string, unknown>;
}
