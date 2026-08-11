import {
  apiErrorSchemaId,
  auditLogsExportResponseSchema,
  auditLogsQuerySchema,
  auditLogsResponseSchema,
  auditLogsSchemaId,
  type AuditLog,
  type AuditLogsQuery,
  type AuditLogsResponse,
} from "@topology/contracts";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type {
  QueryExecutor,
  QueryParameters,
} from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MINIMUM = 10;
const PAGE_SIZE_MAXIMUM = 100;
const PAGE_MAXIMUM = 1_000_000;
const EXPORT_LIMIT = 5_000;
const FILTER_VALUE_LIMIT = 500;
const EXPORT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const AUDIT_LOG_COLUMNS = `SELECT
  audit_logs.id,
  audit_logs.actor_user_id AS actorUserId,
  users.name AS actorName,
  users.email AS actorEmail,
  audit_logs.action,
  audit_logs.module,
  audit_logs.entity_type AS entityType,
  audit_logs.entity_id AS entityId,
  audit_logs.business_no AS businessNo,
  audit_logs.ip_address AS ipAddress,
  audit_logs.device_id AS deviceId,
  audit_logs.sensitive_view AS sensitiveView,
  audit_logs.exported,
  audit_logs.created_at AS createdAt,
  audit_logs.archive_after AS archiveAfter
FROM audit_logs
LEFT JOIN users ON users.id = audit_logs.actor_user_id`;

type AuditLogsAccessContext = Pick<
  AccessContext,
  | "email"
  | "factoryId"
  | "localPreview"
  | "name"
  | "organizationName"
  | "roles"
  | "supplierId"
  | "userId"
>;
type DataRow = Record<string, unknown>;

export interface AuditLogsAuditEvent {
  access: AuditLogsAccessContext;
  action: "export_audit_logs" | "view_audit_logs";
  after: Record<string, unknown>;
  entityId: "list" | number;
  entityType: "audit_log";
  exported?: true;
  module: "系统管理";
  request: FastifyRequest;
  sensitiveView: true;
}

export interface AuditLogExportInput {
  companyName: "广州拓扑睡眠科技有限公司";
  filterSummary: Record<string, string>;
  rows: readonly AuditLog[];
  watermark: string;
}

export interface AuditLogExportPort {
  createXlsx(input: AuditLogExportInput): Promise<Uint8Array> | Uint8Array;
}

export interface AuditLogsModuleOptions {
  audit: (event: AuditLogsAuditEvent) => Promise<void> | void;
  authenticate: (request: FastifyRequest) => Promise<AuditLogsAccessContext>;
  database?: QueryExecutor;
  exporter?: AuditLogExportPort;
  now?: () => Date;
}

export class AuditLogsBadRequestError extends Error {
  readonly statusCode = 400;

  constructor() {
    super("Invalid audit log filters");
    this.name = "AuditLogsBadRequestError";
  }
}

export class AuditLogsForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Audit logs access forbidden");
    this.name = "AuditLogsForbiddenError";
  }
}

export class AuditLogsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Audit logs unavailable");
    this.name = "AuditLogsUnavailableError";
  }
}

function invalidData(): never {
  throw new AuditLogsUnavailableError();
}

function badRequest(): never {
  throw new AuditLogsBadRequestError();
}

function integer(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    return invalidData();
  }
  return value;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value, true);
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidData();
}

function auditLog(row: DataRow): AuditLog {
  return {
    id: integer(row.id),
    actorUserId: nullableInteger(row.actorUserId),
    actorName: nullableString(row.actorName),
    actorEmail: nullableString(row.actorEmail),
    action: string(row.action),
    module: string(row.module),
    entityType: string(row.entityType),
    entityId: string(row.entityId),
    businessNo: nullableString(row.businessNo),
    ipAddress: nullableString(row.ipAddress),
    deviceId: nullableString(row.deviceId),
    sensitiveView: boolean(row.sensitiveView),
    exported: boolean(row.exported),
    createdAt: string(row.createdAt),
    archiveAfter: string(row.archiveAfter),
  };
}

function requestUrl(request: FastifyRequest): URL {
  try {
    return new URL(request.raw.url ?? request.url, "http://127.0.0.1");
  } catch {
    return badRequest();
  }
}

function filterValue(
  params: URLSearchParams,
  name: string,
  trim: boolean,
): string | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  const value = trim ? raw.trim() : raw;
  if (value === "") return undefined;
  if (value.length > FILTER_VALUE_LIMIT) return badRequest();
  return value;
}

function dateFilter(
  params: URLSearchParams,
  name: string,
): string | undefined {
  return filterValue(params, name, false);
}

function legacyPageValue(
  params: URLSearchParams,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = params.get(name);
  const numericValue = raw === null ? defaultValue : Number(raw) || defaultValue;
  const value = Math.min(maximum, Math.max(minimum, numericValue));
  if (!Number.isSafeInteger(value)) {
    return badRequest();
  }
  return value;
}

function booleanFilter(
  params: URLSearchParams,
  name: string,
): boolean | undefined {
  const raw = params.get(name);
  return raw === null || raw === "" ? undefined : raw === "true";
}

interface ParsedFilters {
  filterSummary: Record<string, string>;
  page: number;
  pageSize: number;
  params: QueryParameters;
  whereSql: string;
}

function parseFilters(url: URL, nowIso: string): ParsedFilters {
  const query = url.searchParams;
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const actor = filterValue(query, "actor", true);
  const moduleFilter = filterValue(query, "module", false);
  const action = filterValue(query, "action", false);
  const businessNo = filterValue(query, "businessNo", false);
  const keyword = filterValue(query, "keyword", true);
  const dateFrom = dateFilter(query, "dateFrom");
  const dateTo = dateFilter(query, "dateTo");
  const sensitive = booleanFilter(query, "sensitive");
  const exported = booleanFilter(query, "exported");
  const archiveScope = query.get("archiveScope") || "active";

  if (actor !== undefined) {
    conditions.push("(users.name LIKE ? OR users.email LIKE ?)");
    params.push(`%${actor}%`, `%${actor}%`);
  }
  if (moduleFilter !== undefined) {
    conditions.push("audit_logs.module = ?");
    params.push(moduleFilter);
  }
  if (action !== undefined) {
    conditions.push("audit_logs.action LIKE ?");
    params.push(`%${action}%`);
  }
  if (businessNo !== undefined) {
    conditions.push("audit_logs.business_no LIKE ?");
    params.push(`%${businessNo}%`);
  }
  if (dateFrom !== undefined) {
    conditions.push("audit_logs.created_at >= ?");
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo !== undefined) {
    conditions.push("audit_logs.created_at <= ?");
    params.push(`${dateTo} 23:59:59`);
  }
  if (sensitive !== undefined) {
    conditions.push("audit_logs.sensitive_view = ?");
    params.push(sensitive ? 1 : 0);
  }
  if (exported !== undefined) {
    conditions.push("audit_logs.exported = ?");
    params.push(exported ? 1 : 0);
  }
  if (archiveScope === "active") {
    conditions.push("audit_logs.archive_after >= ?");
    params.push(nowIso);
  } else if (archiveScope === "archived") {
    conditions.push("audit_logs.archive_after < ?");
    params.push(nowIso);
  }
  if (keyword !== undefined) {
    conditions.push(`(
      users.name LIKE ?
      OR users.email LIKE ?
      OR audit_logs.action LIKE ?
      OR audit_logs.entity_type LIKE ?
      OR audit_logs.entity_id LIKE ?
      OR audit_logs.business_no LIKE ?
    )`);
    const pattern = `%${keyword}%`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return {
    filterSummary: Object.fromEntries(query.entries()),
    page: (() => {
      const raw = query.get("page");
      const value = Math.max(1, Number(raw) || 1);
      if (!Number.isFinite(value) || value > PAGE_MAXIMUM) {
        return badRequest();
      }
      return value;
    })(),
    pageSize: legacyPageValue(
      query,
      "pageSize",
      PAGE_SIZE_DEFAULT,
      PAGE_SIZE_MINIMUM,
      PAGE_SIZE_MAXIMUM,
    ),
    params,
    whereSql:
      conditions.length === 0 ? "" : `\nWHERE ${conditions.join("\n  AND ")}`,
  };
}

function currentTime(now: () => Date): Date {
  const value = now();
  if (Number.isNaN(value.getTime())) return invalidData();
  return value;
}

async function queryAuditRows(
  database: QueryExecutor,
  whereSql: string,
  params: QueryParameters,
  limit: number,
  offset?: number,
): Promise<AuditLog[]> {
  const paginationSql = offset === undefined ? "LIMIT ?" : "LIMIT ? OFFSET ?";
  const paginationParams =
    offset === undefined ? [...params, limit] : [...params, limit, offset];
  const rows = await database.query<DataRow>(
    `${AUDIT_LOG_COLUMNS}${whereSql}
ORDER BY audit_logs.created_at DESC, audit_logs.id DESC
${paginationSql}`,
    paginationParams,
  );
  if (rows.length > limit) return invalidData();
  return rows.map(auditLog);
}

async function readAuditPage(
  database: QueryExecutor,
  filters: ParsedFilters,
): Promise<AuditLogsResponse> {
  const offset = (filters.page - 1) * filters.pageSize;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AuditLogsBadRequestError();
  }

  try {
    const [logs, countRows] = await Promise.all([
      queryAuditRows(
        database,
        filters.whereSql,
        filters.params,
        filters.pageSize,
        offset,
      ),
      database.query<DataRow>(
        `SELECT COUNT(*) AS count
FROM audit_logs
LEFT JOIN users ON users.id = audit_logs.actor_user_id${filters.whereSql}`,
        filters.params,
      ),
    ]);
    if (countRows.length !== 1) return invalidData();
    return {
      logs,
      total: integer(countRows[0]?.count, true),
      page: filters.page,
      pageSize: filters.pageSize,
    };
  } catch (error) {
    if (error instanceof AuditLogsUnavailableError) throw error;
    throw new AuditLogsUnavailableError();
  }
}

async function readAuditExport(
  database: QueryExecutor,
  filters: ParsedFilters,
): Promise<AuditLog[]> {
  try {
    return await queryAuditRows(
      database,
      filters.whereSql,
      filters.params,
      EXPORT_LIMIT,
    );
  } catch (error) {
    if (error instanceof AuditLogsUnavailableError) throw error;
    throw new AuditLogsUnavailableError();
  }
}

function requireAdmin(access: AuditLogsAccessContext): void {
  if (!access.roles.includes("admin")) throw new AuditLogsForbiddenError();
}

function sendExport(
  reply: FastifyReply,
  bytes: Uint8Array,
  now: Date,
): FastifyReply {
  const timestamp = now
    .toISOString()
    .replace(/[-:TZ.]/gu, "")
    .slice(0, 14);
  return reply
    .type(EXPORT_CONTENT_TYPE)
    .header(
      "content-disposition",
      `attachment; filename="topology-audit-logs-${timestamp}.xlsx"`,
    )
    .send(Buffer.from(bytes));
}

export async function registerAuditLogsModule(
  app: FastifyInstance,
  options: AuditLogsModuleOptions,
): Promise<void> {
  if (!app.getSchema(auditLogsSchemaId)) {
    app.addSchema(auditLogsResponseSchema);
  }

  app.get<{ Querystring: AuditLogsQuery }>(
    "/api/v1/audit-logs",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["audit-logs"],
        summary: "Read or export filtered audit logs",
        querystring: auditLogsQuerySchema,
        response: {
          200: {
            description: "Audit-log page or XLSX export",
            content: {
              "application/json": {
                schema: { $ref: `${auditLogsSchemaId}#` },
              },
              [EXPORT_CONTENT_TYPE]: {
                schema: auditLogsExportResponseSchema,
              },
            },
          },
          400: { $ref: `${apiErrorSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      const access = await options.authenticate(request);
      requireAdmin(access);
      const url = requestUrl(request);
      const now = currentTime(options.now ?? (() => new Date()));
      const filters = parseFilters(url, now.toISOString());
      const exporting = url.searchParams.get("export") === "xlsx";

      if (!exporting && access.localPreview) {
        return reply.send({ logs: [], total: 0, page: 1, pageSize: 20 });
      }
      if (options.database === undefined) {
        throw new AuditLogsUnavailableError();
      }

      if (exporting) {
        if (options.exporter === undefined) {
          throw new AuditLogsUnavailableError();
        }
        const rows = await readAuditExport(options.database, filters);
        let bytes: Uint8Array;
        try {
          bytes = await options.exporter.createXlsx({
            companyName: "广州拓扑睡眠科技有限公司",
            filterSummary: filters.filterSummary,
            rows,
            watermark: `导出人：${access.name}（${access.email}）｜导出时间：${now.toLocaleString(
              "zh-CN",
              { timeZone: "Asia/Shanghai" },
            )}`,
          });
        } catch {
          throw new AuditLogsUnavailableError();
        }
        if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
          throw new AuditLogsUnavailableError();
        }
        if (!access.localPreview) {
          await options.audit({
            access,
            action: "export_audit_logs",
            module: "系统管理",
            entityType: "audit_log",
            entityId: now.getTime(),
            exported: true,
            sensitiveView: true,
            after: { count: rows.length },
            request,
          });
        }
        return sendExport(reply, bytes, now);
      }

      const response = await readAuditPage(options.database, filters);
      await options.audit({
        access,
        action: "view_audit_logs",
        module: "系统管理",
        entityType: "audit_log",
        entityId: "list",
        sensitiveView: true,
        after: {
          page: filters.page,
          filters: filters.filterSummary,
        },
        request,
      });
      return reply.send(response);
    },
  );
}
