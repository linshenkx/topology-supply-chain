import {
  apiErrorSchemaId,
  usersResponseSchema,
  usersSchemaId,
  type ManagedUser,
  type UserAccountStatus,
  type UserRoleAssignment,
  type UserRoleAssignmentStatus,
  type UsersResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
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
  database?: QueryExecutor;
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
}
