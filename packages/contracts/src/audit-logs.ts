export const auditLogsSchemaId = "AuditLogs";

export interface AuditLogsQuery {
  action?: string;
  actor?: string;
  archiveScope?: string;
  businessNo?: string;
  dateFrom?: string;
  dateTo?: string;
  export?: string;
  exported?: string;
  keyword?: string;
  module?: string;
  page?: string;
  pageSize?: string;
  sensitive?: string;
}

export interface AuditLog {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  module: string;
  entityType: string;
  entityId: string;
  businessNo: string | null;
  ipAddress: string | null;
  deviceId: string | null;
  sensitiveView: boolean;
  exported: boolean;
  createdAt: string;
  archiveAfter: string;
}

export interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

const filterStringSchema = { type: "string", maxLength: 500 } as const;

export const auditLogsQuerySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    action: filterStringSchema,
    actor: filterStringSchema,
    archiveScope: filterStringSchema,
    businessNo: filterStringSchema,
    dateFrom: filterStringSchema,
    dateTo: filterStringSchema,
    export: filterStringSchema,
    exported: filterStringSchema,
    keyword: filterStringSchema,
    module: filterStringSchema,
    page: filterStringSchema,
    pageSize: filterStringSchema,
    sensitive: filterStringSchema,
  },
} as const;

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nullablePositiveIntegerSchema = {
  anyOf: [{ type: "null" }, positiveIntegerSchema],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

export const auditLogSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "actorUserId",
    "actorName",
    "actorEmail",
    "action",
    "module",
    "entityType",
    "entityId",
    "businessNo",
    "ipAddress",
    "deviceId",
    "sensitiveView",
    "exported",
    "createdAt",
    "archiveAfter",
  ],
  properties: {
    id: positiveIntegerSchema,
    actorUserId: nullablePositiveIntegerSchema,
    actorName: nullableStringSchema,
    actorEmail: nullableStringSchema,
    action: { type: "string", minLength: 1 },
    module: { type: "string", minLength: 1 },
    entityType: { type: "string", minLength: 1 },
    entityId: { type: "string", minLength: 1 },
    businessNo: nullableStringSchema,
    ipAddress: nullableStringSchema,
    deviceId: nullableStringSchema,
    sensitiveView: { type: "boolean" },
    exported: { type: "boolean" },
    createdAt: { type: "string", minLength: 1 },
    archiveAfter: { type: "string", minLength: 1 },
  },
} as const;

export const auditLogsResponseSchema = {
  $id: auditLogsSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["logs", "total", "page", "pageSize"],
  properties: {
    logs: {
      type: "array",
      maxItems: 100,
      items: auditLogSchema,
    },
    total: { type: "integer", minimum: 0 },
    page: { type: "number", minimum: 1, maximum: 1_000_000 },
    pageSize: { type: "integer", minimum: 10, maximum: 100 },
  },
} as const;

export const auditLogsExportResponseSchema = {
  type: "string",
  format: "binary",
} as const;
