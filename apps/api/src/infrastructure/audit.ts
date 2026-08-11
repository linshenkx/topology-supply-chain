import type { FastifyRequest } from "fastify";

import type { QueryExecutor } from "./database.js";

const AUDIT_INSERT = `INSERT INTO audit_logs (
  actor_user_id,
  action,
  module,
  entity_type,
  entity_id,
  business_no,
  before_json,
  after_json,
  ip_address,
  device_id,
  sensitive_view,
  exported,
  archive_after
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface AuditAccessContext {
  localPreview: boolean;
  userId: number;
}

export interface AuditWriteEvent {
  access: AuditAccessContext;
  action: string;
  after?: unknown;
  before?: unknown;
  businessNo?: string;
  deviceId?: string | null;
  entityId: string | number;
  entityType: string;
  exported?: boolean;
  ipAddress?: string | null;
  module: string;
  request?: FastifyRequest;
  sensitiveView?: boolean;
}

export interface AuditWriterOptions {
  database?: QueryExecutor;
  now?: () => Date;
}

export class AuditUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Audit service unavailable");
    this.name = "AuditUnavailableError";
  }
}

function unavailable(): never {
  throw new AuditUnavailableError();
}

function requiredText(value: unknown, maximumLength = 200): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return unavailable();
  }
  return value;
}

function optionalText(value: unknown, maximumLength = 200): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, maximumLength);
}

function header(
  request: FastifyRequest | undefined,
  name: string,
  maximumLength: number,
): string | null {
  const value = request?.headers[name];
  if (typeof value !== "string" || value.length > maximumLength) return null;
  return value;
}

function eventMetadata(
  explicit: string | null | undefined,
  request: FastifyRequest | undefined,
  headerName: string,
  maximumLength: number,
): string | null {
  if (explicit !== undefined) {
    return typeof explicit === "string" && explicit.length <= maximumLength
      ? explicit
      : null;
  }
  return header(request, headerName, maximumLength);
}

function json(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return unavailable();
  }
}

function archiveAfter(now: Date): string {
  if (!Number.isFinite(now.getTime())) return unavailable();
  const archive = new Date(now);
  archive.setUTCFullYear(archive.getUTCFullYear() + 5);
  return archive.toISOString();
}

export function createAuditWriter(
  options: AuditWriterOptions,
): (event: AuditWriteEvent) => Promise<void> {
  return async (event) => {
    if (event.access.localPreview) return;
    if (
      !Number.isSafeInteger(event.access.userId) ||
      event.access.userId <= 0 ||
      options.database === undefined
    ) {
      return unavailable();
    }

    try {
      const result = await options.database.execute(AUDIT_INSERT, [
        event.access.userId,
        requiredText(event.action),
        requiredText(event.module),
        requiredText(event.entityType),
        requiredText(String(event.entityId)),
        optionalText(event.businessNo),
        json(event.before),
        json(event.after),
        eventMetadata(event.ipAddress, event.request, "x-real-ip", 100),
        eventMetadata(
          event.deviceId,
          event.request,
          "x-topology-device-id",
          200,
        ),
        event.sensitiveView === true ? 1 : 0,
        event.exported === true ? 1 : 0,
        archiveAfter((options.now ?? (() => new Date()))()),
      ]);

      if (result.affectedRows !== 1) return unavailable();
    } catch (error) {
      if (error instanceof AuditUnavailableError) throw error;
      throw new AuditUnavailableError();
    }
  };
}
