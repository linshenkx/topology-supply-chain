import {
  apiErrorSchemaId,
  approvalsResponseSchema,
  approvalsSchemaId,
  type ApprovalListItem,
  type ApprovalsResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain", "finance"]);
const APPROVAL_LIMIT = 100;
const APPROVAL_QUERY = `SELECT
  id,
  request_no AS requestNo,
  workflow_type AS workflowType,
  summary,
  high_risk AS highRisk,
  status,
  requested_at AS requestedAt,
  CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
FROM approval_requests
ORDER BY requested_at DESC, id DESC
LIMIT ${APPROVAL_LIMIT}`;

type ApprovalAccessContext = Pick<
  AccessContext,
  | "factoryId"
  | "localPreview"
  | "organizationName"
  | "roles"
  | "supplierId"
  | "userId"
>;
type DataRow = Record<string, unknown>;

export interface ApprovalsAuditEvent {
  access: ApprovalAccessContext;
  action: "view";
  module: "approvals";
  entityType: "approval_list";
  entityId: "latest";
  request: FastifyRequest;
}

export interface ApprovalsModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<ApprovalAccessContext>;
  audit: (event: ApprovalsAuditEvent) => Promise<void> | void;
  database?: QueryExecutor;
}

export class ApprovalsForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Approvals access forbidden");
    this.name = "ApprovalsForbiddenError";
  }
}

export class ApprovalsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Approval data unavailable");
    this.name = "ApprovalsUnavailableError";
  }
}

function unavailable(): never {
  throw new ApprovalsUnavailableError();
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return unavailable();
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return unavailable();
  return value;
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return unavailable();
}

function approval(row: DataRow): ApprovalListItem {
  const status = row.status;
  if (
    typeof status !== "string" ||
    !["pending", "approved", "rejected", "cancelled"].includes(status)
  ) {
    return unavailable();
  }

  return {
    id: positiveInteger(row.id),
    requestNo: string(row.requestNo),
    workflowType: string(row.workflowType),
    summary: string(row.summary),
    highRisk: boolean(row.highRisk),
    status: status as ApprovalListItem["status"],
    requestedAt: string(row.requestedAt),
    objectVersion: positiveInteger(row.objectVersion),
  };
}

function assertAllowed(context: ApprovalAccessContext): void {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new ApprovalsForbiddenError();
  }
}

async function readApprovals(
  database: QueryExecutor,
): Promise<ApprovalsResponse> {
  try {
    const rows = await database.query<DataRow>(APPROVAL_QUERY);
    if (rows.length > APPROVAL_LIMIT) return unavailable();
    return { approvals: rows.map(approval) };
  } catch (error) {
    if (error instanceof ApprovalsUnavailableError) throw error;
    throw new ApprovalsUnavailableError();
  }
}

async function auditRead(
  options: ApprovalsModuleOptions,
  access: ApprovalAccessContext,
  request: FastifyRequest,
): Promise<void> {
  try {
    await options.audit({
      access,
      action: "view",
      module: "approvals",
      entityType: "approval_list",
      entityId: "latest",
      request,
    });
  } catch {
    throw new ApprovalsUnavailableError();
  }
}

export async function registerApprovalsModule(
  app: FastifyInstance,
  options: ApprovalsModuleOptions,
): Promise<void> {
  if (!app.getSchema(approvalsSchemaId)) {
    app.addSchema(approvalsResponseSchema);
  }

  app.get<{ Reply: ApprovalsResponse }>(
    "/api/v1/approvals",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["approvals"],
        summary: "Read the company approval list",
        response: {
          200: { $ref: `${approvalsSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      assertAllowed(access);

      if (access.localPreview) {
        return { approvals: [], preview: true };
      }

      if (options.database === undefined) {
        throw new ApprovalsUnavailableError();
      }

      const response = await readApprovals(options.database);
      await auditRead(options, access, request);
      return response;
    },
  );
}
