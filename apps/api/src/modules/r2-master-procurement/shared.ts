import { createHash } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { PlatformError } from "../../errors.js";
import { createAuditWriter } from "../../infrastructure/audit.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";

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

export function jsonValue(value: unknown): import("../../platform/commands.js").JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return bad("Invalid JSON payload");
    return JSON.parse(serialized) as import("../../platform/commands.js").JsonValue;
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

export async function createApproval(
  transaction: QueryExecutor,
  input: {
    entityId: number;
    entityType: string;
    highRisk?: boolean;
    idempotencyKey: string;
    payload: unknown;
    requestedBy: number;
    summary: string;
    workflowType: string;
    discriminator?: string;
  },
): Promise<number> {
  const approvalId = await insertId(
    transaction,
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [
      requestNo("AP-R2", input.idempotencyKey, input.discriminator ?? input.workflowType),
      input.workflowType,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.payload),
      input.highRisk === true ? 1 : 0,
      input.requestedBy,
    ],
  );
  const version = await transaction.execute(
    `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES ('approval_request', ?, 1, CURRENT_TIMESTAMP(3))`,
    [String(approvalId)],
  );
  if (version.affectedRows !== 1) throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Approval version write failed");
  return approvalId;
}

export async function createReminder(
  transaction: QueryExecutor,
  input: { businessNo: string; dueAt: string; entityId: number; entityType: string; reminderType: string },
): Promise<void> {
  const result = await transaction.execute(
    `INSERT INTO reminder_schedules (
       reminder_type, entity_type, entity_id, business_no, due_at, next_run_at,
       recurrence, milestone_days_json, recipient_role_json, recipient_user_ids_json,
       channels_json, severity, quiet_hours_bypass, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'daily_overdue', '[]', '["factory","supply_chain"]',
               '[]', '["in_app","email"]', 'approval', 0, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [input.reminderType, input.entityType, input.entityId, input.businessNo, input.dueAt, input.dueAt],
  );
  if (result.affectedRows !== 1) throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Reminder write failed");
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
    data?: Record<string, import("../../platform/commands.js").JsonValue>;
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
      payload: import("../../platform/commands.js").JsonValue;
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

export async function approvalNotification(
  context: DomainRegistrationContext,
  transaction: QueryExecutor,
  input: {
    approvalId: number;
    idempotencyKey: string;
    targetEntityId: number | string;
    targetEntityType: string;
    workflowType: string;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.approvalId) || input.approvalId <= 0) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Approval notification target is invalid");
  }
  await context.enqueueOutbox(transaction, {
    topic: "notification.dispatch",
    aggregateType: "approval_request",
    aggregateId: String(input.approvalId),
    deduplicationKey: `r2:approval:${input.workflowType}:${input.approvalId}:${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`,
    payload: {
      approvalId: input.approvalId,
      recipientRole: "supply_chain",
      type: input.workflowType,
      targetEntityType: input.targetEntityType,
      targetEntityId: String(input.targetEntityId),
    },
  });
}

interface FileRow extends DataRow {
  category: string;
  factoryId: number | null;
  id: number;
  entityId: string | null;
  entityType: string | null;
  objectKey: string;
  ownerUserId: number;
  scanStatus: string;
  supplierId: number | null;
}

export async function requireFile(
  transaction: QueryExecutor,
  access: AccessContext,
  selector: { id?: number; objectKey?: string },
  categories?: readonly string[],
  entity?: { entityIds: readonly (number | string)[]; entityType: string },
): Promise<FileRow> {
  const useId = selector.id !== undefined;
  const value = useId ? selector.id : selector.objectKey;
  const rows = await transaction.query<FileRow>(
    `SELECT id, object_key AS objectKey, category, entity_type AS entityType,
            entity_id AS entityId, owner_user_id AS ownerUserId,
            factory_id AS factoryId, supplier_id AS supplierId, scan_status AS scanStatus
     FROM file_objects WHERE ${useId ? "id" : "object_key"} = ? LIMIT 1 FOR SHARE`,
    [value] as never[],
  );
  const row = rows[0];
  if (row === undefined || row.scanStatus !== "clean") return missing("Authorized clean file not found");
  if (categories !== undefined && !categories.includes(row.category)) return forbidden("File category rejected");
  if (entity !== undefined &&
      (row.entityType !== entity.entityType || row.entityId === null || !entity.entityIds.some((id) => String(id) === row.entityId))) {
    return forbidden("File entity binding rejected");
  }
  const scoped =
    isInternal(access) ||
    row.ownerUserId === access.userId ||
    (access.roles.includes("factory") && access.factoryId !== null && row.factoryId === access.factoryId) ||
    (access.roles.includes("supplier_qc") && access.supplierId !== null && row.supplierId === access.supplierId);
  if (!scoped) return forbidden("File scope rejected");
  return row;
}
