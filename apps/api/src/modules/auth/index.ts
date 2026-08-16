import { createHash } from "node:crypto";

import {
  apiErrorSchemaId,
  sessionResponseSchema,
  sessionSchemaId,
  type SessionResponse,
} from "@topology/contracts";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import type {
  DatabaseClient,
  QueryExecutor,
} from "../../infrastructure/database.js";
import { registerAuthWriteRoutes } from "./writes.js";
import type { OtpSealingConfig } from "../../platform/secrets.js";
import { csrfCookie } from "../../platform/security.js";

export const SESSION_COOKIE = "topology_session";

const SESSION_TOKEN_PATTERN = /^[a-f\d]{64}$/iu;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "::ffff:127.0.0.1",
]);
const SESSION_SECURITY_POLICY = {
  passwordAttemptsBeforeLock: 5,
  trustedDeviceDays: 90,
  highRiskRequiresSms: true,
  separationOfDuties: true,
} as const;

export interface AccessContext {
  sessionId: number | null;
  userId: number;
  email: string;
  name: string;
  roles: string[];
  factoryId: number | null;
  supplierId: number | null;
  organizationName: string;
  localPreview: boolean;
}

export interface AuthEnvironment {
  appEnv?: string;
  deployTarget?: string;
  nodeEnv?: string;
  cookieSecure?: boolean;
}

export interface AuthenticateOptions {
  environment?: AuthEnvironment;
  now?: () => Date;
}

export interface AuthModuleOptions extends AuthenticateOptions {
  database?: DatabaseClient;
  fixedOtpCode?: string;
  sessionSigningKey?: string;
  otpSealing?: OtpSealingConfig;
}

type SessionUserRow = Record<string, unknown> & {
  sessionId: number;
  userId: number;
  email: string;
  name: string;
  primaryRole: string;
  factoryId: number | null;
  supplierId: number | null;
  organizationName: string;
  accountStatus: string;
};

type RoleRow = Record<string, unknown> & {
  roleCode: string;
};

type RevalidatedSessionRow = Record<string, unknown> & {
  sessionId: number;
  accountStatus: string;
};

declare module "fastify" {
  interface FastifyRequest {
    accessContext: AccessContext | null;
  }
}

export class AuthenticationError extends Error {
  readonly statusCode: number;

  constructor(statusCode: 401 | 403 | 503) {
    super(statusCode === 503 ? "Authentication service unavailable" : "Authentication failed");
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
  }
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function resolveEnvironment(environment: AuthEnvironment | undefined): Required<AuthEnvironment> {
  return {
    appEnv: environment?.appEnv ?? process.env.APP_ENV ?? "",
    deployTarget: environment?.deployTarget ?? process.env.DEPLOY_TARGET ?? "",
    nodeEnv: environment?.nodeEnv ?? process.env.NODE_ENV ?? "",
    cookieSecure: environment?.cookieSecure ?? true,
  };
}

function isLocalPreviewRequest(
  request: FastifyRequest,
  environment: AuthEnvironment | undefined,
): boolean {
  const resolved = resolveEnvironment(environment);

  // An explicit insecure loopback transport is the real-auth E2E mode. It
  // must not silently fall back to the local preview identity or challenge.
  if (resolved.cookieSecure === false) return false;

  if (
    normalized(resolved.appEnv) === "production" ||
    normalized(resolved.deployTarget) === "aliyun" ||
    normalized(resolved.nodeEnv) === "production"
  ) {
    return false;
  }

  const hostname = request.hostname.trim().toLowerCase();
  const requestIp = request.ip.trim().toLowerCase();
  const remoteAddress = request.raw.socket.remoteAddress?.trim().toLowerCase();

  return (
    LOOPBACK_HOSTS.has(hostname) &&
    LOOPBACK_ADDRESSES.has(requestIp) &&
    remoteAddress !== undefined &&
    LOOPBACK_ADDRESSES.has(remoteAddress)
  );
}

type SessionCookie =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "valid"; token: string };

function readSessionCookie(cookieHeader: string | undefined): SessionCookie {
  if (cookieHeader === undefined) return { kind: "missing" };

  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).trim();
    if (name !== SESSION_COOKIE) continue;

    if (separator < 0) return { kind: "malformed" };
    matches.push(part.slice(separator + 1).trim());
  }

  if (matches.length === 0) return { kind: "missing" };
  if (cookieHeader.length > 8_192 || matches.length !== 1) {
    return { kind: "malformed" };
  }
  const token = matches[0];
  return token !== undefined && SESSION_TOKEN_PATTERN.test(token)
    ? { kind: "valid", token }
    : { kind: "malformed" };
}

function previewContext(): AccessContext {
  return {
    sessionId: null,
    userId: 0,
    email: "preview@topologygz.com",
    name: "本地预览管理员",
    roles: ["admin", "supply_chain", "finance", "company_qc"],
    factoryId: null,
    supplierId: null,
    organizationName: "广州拓扑睡眠科技有限公司",
    localPreview: true,
  };
}

function requireSessionRow(row: SessionUserRow | undefined): SessionUserRow {
  if (row === undefined) throw new AuthenticationError(401);

  if (
    !Number.isSafeInteger(row.sessionId) || row.sessionId <= 0 ||
    !Number.isSafeInteger(row.userId) || row.userId <= 0 ||
    typeof row.email !== "string" || row.email.length === 0 ||
    typeof row.name !== "string" || row.name.length === 0 ||
    typeof row.primaryRole !== "string" || row.primaryRole.length === 0 ||
    typeof row.organizationName !== "string" ||
    row.organizationName.trim().length === 0 ||
    (row.factoryId !== null &&
      (!Number.isSafeInteger(row.factoryId) || row.factoryId <= 0)) ||
    (row.supplierId !== null &&
      (!Number.isSafeInteger(row.supplierId) || row.supplierId <= 0)) ||
    typeof row.accountStatus !== "string"
  ) {
    throw new AuthenticationError(503);
  }

  return row;
}

function requireOrganizationBinding(session: SessionUserRow): void {
  if (session.factoryId !== null && session.supplierId !== null) {
    throw new AuthenticationError(403);
  }
  if (
    session.primaryRole === "factory" &&
    (session.factoryId === null || session.supplierId !== null)
  ) {
    throw new AuthenticationError(403);
  }
  if (
    session.primaryRole === "supplier_qc" &&
    (session.supplierId === null || session.factoryId !== null)
  ) {
    throw new AuthenticationError(403);
  }
}

async function loadSessionContext(
  database: QueryExecutor,
  token: string,
  now: Date,
): Promise<AccessContext> {
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  let sessionRows: readonly SessionUserRow[];

  try {
    sessionRows = await database.query<SessionUserRow>(
      `SELECT
         sessions.id AS sessionId,
         users.id AS userId,
         users.email AS email,
         users.name AS name,
         users.role AS primaryRole,
         users.factory_id AS factoryId,
         users.supplier_id AS supplierId,
         users.organization_name AS organizationName,
         users.account_status AS accountStatus
       FROM auth_sessions AS sessions
       INNER JOIN users AS users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
       LIMIT 1`,
      [tokenHash, nowIso],
    );
  } catch {
    throw new AuthenticationError(503);
  }

  const session = requireSessionRow(sessionRows[0]);
  if (session.accountStatus !== "active") throw new AuthenticationError(403);
  requireOrganizationBinding(session);

  let roleRows: readonly RoleRow[];
  try {
    roleRows = await database.query<RoleRow>(
      `SELECT role_code AS roleCode
       FROM user_roles
       WHERE user_id = ?
         AND status = 'active'
         AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY role_code`,
      [session.userId, today, today],
    );
  } catch {
    throw new AuthenticationError(503);
  }

  let lastSeenResult: { affectedRows: number };
  try {
    lastSeenResult = await database.execute(
      `UPDATE auth_sessions AS sessions
       INNER JOIN users AS users ON users.id = sessions.user_id
       SET sessions.last_seen_at = CURRENT_TIMESTAMP(3)
       WHERE sessions.id = ?
         AND sessions.token_hash = ?
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > ?
         AND users.account_status = 'active'`,
      [session.sessionId, tokenHash, nowIso],
    );
  } catch {
    // Authentication fails closed when the security heartbeat cannot be persisted.
    throw new AuthenticationError(503);
  }

  if (lastSeenResult.affectedRows === 0) {
    let revalidatedRows: readonly RevalidatedSessionRow[];
    try {
      revalidatedRows = await database.query<RevalidatedSessionRow>(
        `SELECT
           sessions.id AS sessionId,
           users.account_status AS accountStatus
         FROM auth_sessions AS sessions
         INNER JOIN users AS users ON users.id = sessions.user_id
         WHERE sessions.id = ?
           AND sessions.token_hash = ?
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > ?
         LIMIT 1`,
        [session.sessionId, tokenHash, nowIso],
      );
    } catch {
      throw new AuthenticationError(503);
    }

    const revalidated = revalidatedRows[0];
    if (revalidated === undefined) {
      // A concurrent revoke or expiry wins over the earlier read.
      throw new AuthenticationError(401);
    }
    if (
      revalidated.sessionId !== session.sessionId ||
      typeof revalidated.accountStatus !== "string"
    ) {
      throw new AuthenticationError(503);
    }
    if (revalidated.accountStatus !== "active") {
      throw new AuthenticationError(403);
    }
  } else if (lastSeenResult.affectedRows !== 1) {
    throw new AuthenticationError(503);
  }

  const delegatedRoles = roleRows.flatMap((row) =>
    typeof row.roleCode === "string" && row.roleCode.length > 0
      ? [row.roleCode]
      : [],
  );

  return {
    sessionId: session.sessionId,
    userId: session.userId,
    email: session.email,
    name: session.name,
    roles: Array.from(new Set([session.primaryRole, ...delegatedRoles])),
    factoryId: session.factoryId,
    supplierId: session.supplierId,
    organizationName: session.organizationName,
    localPreview: false,
  };
}

export async function authenticateRequest(
  database: QueryExecutor | undefined,
  request: FastifyRequest,
  options: AuthenticateOptions = {},
): Promise<AccessContext> {
  const sessionCookie = readSessionCookie(request.headers.cookie);

  if (sessionCookie.kind === "malformed") {
    throw new AuthenticationError(401);
  }

  if (sessionCookie.kind === "valid") {
    if (database === undefined) throw new AuthenticationError(503);

    const now = options.now?.() ?? new Date();
    if (Number.isNaN(now.getTime())) throw new AuthenticationError(503);

    return loadSessionContext(database, sessionCookie.token, now);
  }

  if (isLocalPreviewRequest(request, options.environment)) {
    return previewContext();
  }

  if (database === undefined) throw new AuthenticationError(503);
  throw new AuthenticationError(401);
}

export function createAuthenticatePreHandler(
  options: AuthModuleOptions,
): preHandlerHookHandler {
  return async (request) => {
    request.accessContext = await authenticateRequest(
      options.database,
      request,
      options,
    );
  };
}

export function requireAccessContext(request: FastifyRequest): AccessContext {
  if (request.accessContext === null || request.accessContext === undefined) {
    throw new AuthenticationError(401);
  }
  return request.accessContext;
}

function sessionResponse(context: AccessContext): SessionResponse {
  return {
    user: {
      id: context.userId,
      email: context.email,
      name: context.name,
      roles: context.roles,
      factoryId: context.factoryId,
      supplierId: context.supplierId,
    },
    security: SESSION_SECURITY_POLICY,
    localPreview: context.localPreview,
  };
}

export async function registerAuthModule(
  app: FastifyInstance,
  options: AuthModuleOptions,
): Promise<void> {
  if (!app.hasRequestDecorator("accessContext")) {
    app.decorateRequest("accessContext", null);
  }
  if (!app.getSchema(sessionSchemaId)) {
    app.addSchema(sessionResponseSchema);
  }

  app.get<{ Reply: SessionResponse }>(
    "/api/v1/session",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      preHandler: createAuthenticatePreHandler(options),
      schema: {
        tags: ["authentication"],
        summary: "Current authenticated session",
        response: {
          200: { $ref: `${sessionSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      const context = requireAccessContext(request);
      const existing = readSessionCookie(request.headers.cookie);
      if (!context.localPreview && existing.kind === "valid" && options.sessionSigningKey !== undefined) {
        reply.header("set-cookie", csrfCookie(options.sessionSigningKey, existing.token, 12 * 60 * 60, resolveEnvironment(options.environment).cookieSecure));
      }
      return sessionResponse(context);
    },
  );

  await registerAuthWriteRoutes(app, {
    authenticate: (request) => authenticateRequest(options.database, request, options),
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sessionSigningKey === undefined
      ? {}
      : { sessionSigningKey: options.sessionSigningKey }),
    ...(options.otpSealing === undefined ? {} : { otpSealing: options.otpSealing }),
    ...(options.fixedOtpCode === undefined ? {} : { fixedOtpCode: options.fixedOtpCode }),
  });
}
