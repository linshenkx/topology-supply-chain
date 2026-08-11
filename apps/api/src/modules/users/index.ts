import {
  assignUserRoleCommandSchema,
  apiErrorSchemaId,
  commandHeadersSchema,
  commandResponseSchema,
  revokeUserRoleCommandSchema,
  unlockUserCommandSchema,
  usersResponseSchema,
  usersSchemaId,
  type ManagedUser,
  type UserAccountStatus,
  type UserRoleAssignment,
  type UserRoleAssignmentStatus,
  type UsersResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { PlatformError } from "../../errors.js";
import { createAuditWriter } from "../../infrastructure/audit.js";
import type {
  DatabaseClient,
  QueryExecutor,
} from "../../infrastructure/database.js";
import { executeCommand, readIdempotencyKey } from "../../platform/commands.js";
import { enqueueOutbox } from "../../platform/outbox.js";
import { requireCsrf, requireSameOrigin } from "../../platform/security.js";
import type { AccessContext } from "../auth/index.js";

const USER_LIMIT = 1_000;
const ROLE_ASSIGNMENT_LIMIT = 5_000;

const USER_COLUMNS = `SELECT
  id,
  email,
  mobile,
  name,
  role AS primaryRole,
  factory_id AS factoryId,
  supplier_id AS supplierId,
  organization_name AS organizationName,
  account_status AS accountStatus,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM users`;

const ROLE_ASSIGNMENT_COLUMNS = `SELECT
  id,
  user_id AS userId,
  role_code AS roleCode,
  effective_from AS effectiveFrom,
  effective_to AS effectiveTo,
  status,
  requested_by AS requestedBy,
  reviewed_by AS reviewedBy,
  reviewed_at AS reviewedAt
FROM user_roles`;

type UsersAccessContext = Pick<
  AccessContext,
  | "email"
  | "factoryId"
  | "localPreview"
  | "name"
  | "organizationName"
  | "roles"
  | "supplierId"
  | "userId"
  | "sessionId"
>;
type DataRow = Record<string, unknown>;

export interface UsersAuditEvent {
  access: UsersAccessContext;
  action: "view";
  entityId: "all";
  entityType: "user_list";
  module: "identity";
  request: FastifyRequest;
  sensitiveView: true;
}

export interface UsersModuleOptions {
  audit: (event: UsersAuditEvent) => Promise<void> | void;
  authenticate: (request: FastifyRequest) => Promise<UsersAccessContext>;
  database?: DatabaseClient;
  now?: () => Date;
}

export class UsersForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Users access forbidden");
    this.name = "UsersForbiddenError";
  }
}

export class UsersUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Users unavailable");
    this.name = "UsersUnavailableError";
  }
}

function invalidData(): never {
  throw new UsersUnavailableError();
}

function integer(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
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

function enumeration<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return invalidData();
  }
  return value as Value;
}

function maskMobile(value: string): string {
  return value.length === 11
    ? `${value.slice(0, 3)}****${value.slice(-4)}`
    : "";
}

function userBase(row: DataRow): Omit<ManagedUser, "roleAssignments" | "roles"> & {
  primaryRole: string;
} {
  return {
    id: integer(row.id),
    email: string(row.email),
    mobile: maskMobile(string(row.mobile, true)),
    name: string(row.name),
    primaryRole: string(row.primaryRole),
    accountStatus: enumeration<UserAccountStatus>(row.accountStatus, [
      "pending",
      "active",
      "locked",
      "disabled",
    ]),
    organizationName: string(row.organizationName, true),
    factoryId: nullableInteger(row.factoryId),
    supplierId: nullableInteger(row.supplierId),
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function roleAssignment(row: DataRow): UserRoleAssignment & { userId: number } {
  return {
    id: integer(row.id),
    userId: integer(row.userId),
    roleCode: string(row.roleCode),
    effectiveFrom: string(row.effectiveFrom),
    effectiveTo: nullableString(row.effectiveTo),
    status: enumeration<UserRoleAssignmentStatus>(row.status, [
      "pending",
      "active",
      "expired",
      "revoked",
    ]),
    requestedBy: integer(row.requestedBy),
    reviewedBy: nullableInteger(row.reviewedBy),
    reviewedAt: nullableString(row.reviewedAt),
  };
}

function ensureBoundedRows(
  rows: readonly DataRow[],
  maximum: number,
): readonly DataRow[] {
  if (rows.length > maximum) return invalidData();
  return rows;
}

function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0 || count > USER_LIMIT) {
    return invalidData();
  }
  return Array.from({ length: count }, () => "?").join(", ");
}

function currentDay(now: () => Date): string {
  const value = now();
  if (Number.isNaN(value.getTime())) return invalidData();
  return value.toISOString().slice(0, 10);
}

async function queryUsers(
  database: QueryExecutor,
  today: string,
): Promise<UsersResponse> {
  await database.execute(
    `UPDATE user_roles
SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
WHERE status = ?
  AND effective_to IS NOT NULL
  AND effective_to < ?`,
    ["expired", "active", today],
  );

  const userRows = ensureBoundedRows(
    await database.query<DataRow>(
      `${USER_COLUMNS}
ORDER BY name ASC, id ASC
LIMIT ${USER_LIMIT + 1}`,
    ),
    USER_LIMIT,
  );
  const bases = userRows.map(userBase);
  if (bases.length === 0) return { users: [] };

  const userIds = bases.map((row) => row.id);
  const assignmentRows = ensureBoundedRows(
    await database.query<DataRow>(
      `${ROLE_ASSIGNMENT_COLUMNS}
WHERE user_id IN (${placeholders(userIds.length)})
ORDER BY user_id ASC, id ASC
LIMIT ${ROLE_ASSIGNMENT_LIMIT + 1}`,
      userIds,
    ),
    ROLE_ASSIGNMENT_LIMIT,
  ).map(roleAssignment);
  const usersById = new Map(bases.map((row) => [row.id, row]));
  const assignmentsByUser = new Map<number, UserRoleAssignment[]>();
  const activeRolesByUser = new Map<number, string[]>();

  for (const row of assignmentRows) {
    if (!usersById.has(row.userId)) return invalidData();
    const { userId, ...assignment } = row;
    assignmentsByUser.set(userId, [
      ...(assignmentsByUser.get(userId) ?? []),
      assignment,
    ]);
    if (assignment.status === "active") {
      activeRolesByUser.set(userId, [
        ...(activeRolesByUser.get(userId) ?? []),
        assignment.roleCode,
      ]);
    }
  }

  return {
    users: bases.map(({ primaryRole, ...base }) => ({
      ...base,
      roles: Array.from(
        new Set([primaryRole, ...(activeRolesByUser.get(base.id) ?? [])]),
      ),
      roleAssignments: assignmentsByUser.get(base.id) ?? [],
    })),
  };
}

async function readUsers(
  database: QueryExecutor,
  today: string,
): Promise<UsersResponse> {
  try {
    return await queryUsers(database, today);
  } catch (error) {
    if (error instanceof UsersUnavailableError) throw error;
    throw new UsersUnavailableError();
  }
}

function requireAdmin(access: UsersAccessContext): void {
  if (!access.roles.includes("admin")) throw new UsersForbiddenError();
}

const ASSIGNABLE_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "factory",
  "supplier_qc",
  "company_qc",
  "receiver",
]);

interface UserWriteRow extends Record<string, unknown> {
  accountStatus: string;
  email: string;
  id: number;
  name: string;
  primaryRole: string;
}

interface RoleWriteRow extends Record<string, unknown> {
  id: number;
  roleCode: string;
  status: string;
  userId: number;
}

function writeDatabase(options: UsersModuleOptions): DatabaseClient {
  if (options.database === undefined) throw new UsersUnavailableError();
  return options.database;
}

function requireWriteAccess(access: UsersAccessContext): void {
  requireAdmin(access);
  if (access.localPreview || access.sessionId === null) {
    throw new UsersForbiddenError();
  }
}

function writeUser(row: UserWriteRow | undefined): UserWriteRow {
  if (row === undefined) throw new PlatformError(404, "NOT_FOUND", "User not found");
  return {
    ...row,
    id: integer(row.id),
    name: string(row.name),
    email: string(row.email),
    accountStatus: string(row.accountStatus),
    primaryRole: string(row.primaryRole),
  };
}

async function lockedUser(
  transaction: QueryExecutor,
  userId: number,
): Promise<UserWriteRow> {
  const rows = await transaction.query<UserWriteRow>(
    `SELECT id, name, email, role AS primaryRole, account_status AS accountStatus
     FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
    [userId],
  );
  return writeUser(rows[0]);
}

function validDateRange(
  effectiveFrom: string,
  effectiveTo: string | null,
): void {
  const dateValue = (value: string): number | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (match === null) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? timestamp
      : null;
  };
  const start = dateValue(effectiveFrom);
  const end = effectiveTo === null ? null : dateValue(effectiveTo);
  if (
    start === null ||
    (effectiveTo !== null && end === null) ||
    (end !== null && (end < start || end - start > 90 * 86_400_000))
  ) {
    throw new PlatformError(400, "BAD_REQUEST", "Invalid role effective period");
  }
}

async function writeAudit(
  transaction: QueryExecutor,
  access: UsersAccessContext,
  request: FastifyRequest,
  event: {
    action: string;
    after?: unknown;
    before?: unknown;
    businessNo: string;
    entityId: number;
    entityType: string;
  },
  at: Date,
): Promise<void> {
  await createAuditWriter({ database: transaction, now: () => at })({
    access,
    action: event.action,
    module: "identity",
    entityType: event.entityType,
    entityId: event.entityId,
    businessNo: event.businessNo,
    request,
    ...(event.before === undefined ? {} : { before: event.before }),
    ...(event.after === undefined ? {} : { after: event.after }),
  });
}

async function registerUserWriteRoutes(
  app: FastifyInstance,
  options: UsersModuleOptions,
): Promise<void> {
  app.post<{
    Body: {
      userId: number;
      roleCode: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
      reason: string;
    };
  }>(
    "/api/v1/users",
    {
      schema: {
        tags: ["users"],
        summary: "Request a managed user role assignment",
        headers: commandHeadersSchema,
        body: assignUserRoleCommandSchema,
        response: { 201: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      requireWriteAccess(access);
      const body = request.body;
      const roleCode = body.roleCode.trim();
      const effectiveTo = body.effectiveTo ?? null;
      if (!ASSIGNABLE_ROLES.has(roleCode)) {
        throw new PlatformError(400, "BAD_REQUEST", "Role is not assignable");
      }
      validDateRange(body.effectiveFrom, effectiveTo);
      const at = options.now?.() ?? new Date();
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "users.assign-role",
        database: writeDatabase(options),
        payload: { ...body, roleCode, effectiveTo },
        request,
        responseStatus: 201,
        run: async ({ transaction }) => {
          const target = await lockedUser(transaction, body.userId);
          if (target.accountStatus === "disabled") {
            throw new PlatformError(409, "CONFLICT", "Disabled user cannot receive roles");
          }
          const existing = await transaction.query<Record<string, unknown>>(
            `SELECT id FROM user_roles
             WHERE user_id = ? AND role_code = ? AND status IN ('pending', 'active')
             LIMIT 1 FOR UPDATE`,
            [target.id, roleCode],
          );
          if (target.primaryRole === roleCode || existing.length > 0) {
            throw new PlatformError(409, "CONFLICT", "Role already assigned or pending");
          }
          const insertedRole = await transaction.execute(
            `INSERT INTO user_roles (
               user_id, role_code, effective_from, effective_to, status,
               requested_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [target.id, roleCode, body.effectiveFrom, effectiveTo, access.userId],
          );
          const roleRequestId = insertedRole.insertId;
          if (roleRequestId === undefined || roleRequestId <= 0) throw new UsersUnavailableError();
          const requestNo = `AP-ROLE-${access.userId}-${readIdempotencyKey(request).slice(0, 24)}`;
          const insertedApproval = await transaction.execute(
            `INSERT INTO approval_requests (
               request_no, workflow_type, entity_type, entity_id, summary,
               payload_json, high_risk, status, requested_by, requested_at,
               created_at, updated_at
             ) VALUES (?, 'user_role_change', 'user_role', ?, ?, ?, 1,
                       'pending', ?, CURRENT_TIMESTAMP(3),
                       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [requestNo, roleRequestId, `为${target.name}新增角色：${roleCode}`,
              JSON.stringify({ userId: target.id, roleCode, effectiveFrom: body.effectiveFrom,
                effectiveTo, reason: body.reason.trim() }), access.userId],
          );
          const approvalId = insertedApproval.insertId;
          if (approvalId === undefined || approvalId <= 0) throw new UsersUnavailableError();
          await writeAudit(transaction, access, request, {
            action: "request_role_change",
            entityType: "user_role",
            entityId: roleRequestId,
            businessNo: target.email,
            after: { roleCode, effectiveFrom: body.effectiveFrom, effectiveTo, approvalId, reason: body.reason.trim() },
          }, at);
          await enqueueOutbox(transaction, {
            topic: "notification.dispatch",
            aggregateType: "approval_request",
            aggregateId: String(approvalId),
            deduplicationKey: `approval:${approvalId}:created`,
            payload: { approvalId, recipientRole: "admin", type: "user_role_change" },
          });
          return { success: true, roleRequestId, approvalId, status: "pending" };
        },
      });
      return reply.status(response.statusCode).send(response.body);
    },
  );

  app.delete<{ Body: { roleAssignmentId: number; reason: string } }>(
    "/api/v1/users",
    {
      schema: {
        tags: ["users"],
        summary: "Request revocation of an additional role",
        headers: commandHeadersSchema,
        body: revokeUserRoleCommandSchema,
        response: { 201: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      requireWriteAccess(access);
      const at = options.now?.() ?? new Date();
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "users.revoke-role",
        database: writeDatabase(options),
        payload: request.body,
        request,
        responseStatus: 201,
        run: async ({ transaction }) => {
          const roleRows = await transaction.query<RoleWriteRow>(
            `SELECT id, user_id AS userId, role_code AS roleCode, status
             FROM user_roles WHERE id = ? LIMIT 1 FOR UPDATE`,
            [request.body.roleAssignmentId],
          );
          const role = roleRows[0];
          if (role === undefined) throw new PlatformError(404, "NOT_FOUND", "Role assignment not found");
          if (string(role.status) !== "active") {
            throw new PlatformError(409, "CONFLICT", "Only active roles can be revoked");
          }
          const target = await lockedUser(transaction, integer(role.userId));
          const pending = await transaction.query<Record<string, unknown>>(
            `SELECT id FROM approval_requests
             WHERE workflow_type = 'user_role_change' AND entity_id = ? AND status = 'pending'
             LIMIT 1 FOR UPDATE`,
            [request.body.roleAssignmentId],
          );
          if (pending.length > 0) throw new PlatformError(409, "CONFLICT", "Role change already pending");
          const requestNo = `AP-ROLE-REVOKE-${access.userId}-${readIdempotencyKey(request).slice(0, 16)}`;
          const inserted = await transaction.execute(
            `INSERT INTO approval_requests (
               request_no, workflow_type, entity_type, entity_id, summary,
               payload_json, high_risk, status, requested_by, requested_at,
               created_at, updated_at
             ) VALUES (?, 'user_role_change', 'user_role', ?, ?, ?, 1,
                       'pending', ?, CURRENT_TIMESTAMP(3),
                       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [requestNo, request.body.roleAssignmentId,
              `撤销 ${target.name} 的角色：${string(role.roleCode)}`,
              JSON.stringify({ operation: "revoke", userId: target.id,
                roleCode: string(role.roleCode), reason: request.body.reason.trim() }),
              access.userId],
          );
          const approvalId = inserted.insertId;
          if (approvalId === undefined || approvalId <= 0) throw new UsersUnavailableError();
          await writeAudit(transaction, access, request, {
            action: "request_role_revocation",
            entityType: "user_role",
            entityId: request.body.roleAssignmentId,
            businessNo: target.email,
            before: { roleCode: string(role.roleCode), status: "active" },
            after: { requestedStatus: "revoked", approvalId, reason: request.body.reason.trim() },
          }, at);
          await enqueueOutbox(transaction, {
            topic: "notification.dispatch",
            aggregateType: "approval_request",
            aggregateId: String(approvalId),
            deduplicationKey: `approval:${approvalId}:created`,
            payload: { approvalId, recipientRole: "admin", type: "user_role_change" },
          });
          return { success: true, roleAssignmentId: request.body.roleAssignmentId, approvalId, status: "pending" };
        },
      });
      return reply.status(response.statusCode).send(response.body);
    },
  );

  app.patch<{ Body: { userId: number; action: "unlock" } }>(
    "/api/v1/users",
    {
      schema: {
        tags: ["users"],
        summary: "Unlock a managed user and revoke existing sessions",
        headers: commandHeadersSchema,
        body: unlockUserCommandSchema,
        response: { 200: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      requireWriteAccess(access);
      const at = options.now?.() ?? new Date();
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "users.unlock",
        database: writeDatabase(options),
        payload: request.body,
        request,
        run: async ({ transaction }) => {
          const target = await lockedUser(transaction, request.body.userId);
          if (target.accountStatus !== "locked") {
            throw new PlatformError(409, "VERSION_CONFLICT", "User is no longer locked");
          }
          const changed = await transaction.execute(
            `UPDATE users SET account_status = 'active', updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND account_status = 'locked'`,
            [target.id],
          );
          if (changed.affectedRows !== 1) {
            throw new PlatformError(409, "VERSION_CONFLICT", "User state changed");
          }
          const credentialReset = await transaction.execute(
            `UPDATE auth_credentials SET failed_attempts = 0, locked_at = NULL,
                 updated_at = CURRENT_TIMESTAMP(3)
             WHERE user_id = ?`,
            [target.id],
          );
          if (credentialReset.affectedRows !== 1) throw new UsersUnavailableError();
          await transaction.execute(
            `UPDATE auth_sessions SET revoked_at = ?
             WHERE user_id = ? AND revoked_at IS NULL`,
            [at.toISOString(), target.id],
          );
          await transaction.execute(
            `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
             VALUES ('user', ?, 2, CURRENT_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE version = version + 1,
               updated_at = CURRENT_TIMESTAMP(3)`,
            [String(target.id)],
          );
          await writeAudit(transaction, access, request, {
            action: "unlock",
            entityType: "user",
            entityId: target.id,
            businessNo: target.email,
            before: { accountStatus: "locked" },
            after: { accountStatus: "active", activeSessionsRevoked: true },
          }, at);
          return { success: true, userId: target.id, accountStatus: "active" };
        },
      });
      return reply.status(response.statusCode).send(response.body);
    },
  );
}

export async function registerUsersModule(
  app: FastifyInstance,
  options: UsersModuleOptions,
): Promise<void> {
  if (!app.getSchema(usersSchemaId)) app.addSchema(usersResponseSchema);

  app.get<{ Reply: UsersResponse }>(
    "/api/v1/users",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["users"],
        summary: "Read managed users and role assignments",
        response: {
          200: { $ref: `${usersSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      requireAdmin(access);
      if (access.localPreview) return { users: [], preview: true };
      if (options.database === undefined) throw new UsersUnavailableError();

      const response = await readUsers(
        options.database,
        currentDay(options.now ?? (() => new Date())),
      );
      await options.audit({
        access,
        action: "view",
        module: "identity",
        entityType: "user_list",
        entityId: "all",
        sensitiveView: true,
        request,
      });
      return response;
    },
  );
  await registerUserWriteRoutes(app, options);
}
