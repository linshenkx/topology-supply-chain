import { createHash, createHmac, pbkdf2 as pbkdf2Callback } from "node:crypto";
import { promisify } from "node:util";

import {
  apiErrorSchemaId,
  commandHeadersSchema,
  commandResponseSchema,
  loginCommandSchema,
  loginVerifyCommandSchema,
  stepUpRequestCommandSchema,
  stepUpVerifyCommandSchema,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { PlatformError } from "../../errors.js";
import { createAuditWriter } from "../../infrastructure/audit.js";
import type {
  DatabaseClient,
  QueryExecutor,
} from "../../infrastructure/database.js";
import {
  executeCommand,
  readIdempotencyKey,
  type JsonValue,
} from "../../platform/commands.js";
import { enqueueOutbox } from "../../platform/outbox.js";
import { sealOtp, type OtpSealingConfig } from "../../platform/secrets.js";
import {
  clearSessionCookies,
  deriveSessionToken,
  requireCsrf,
  requireSameOrigin,
  sessionCookies,
} from "../../platform/security.js";
import {
  type AccessContext,
  type AuthenticateOptions,
} from "./index.js";

const pbkdf2 = promisify(pbkdf2Callback);
const SESSION_SECONDS = 12 * 60 * 60;
const TRUSTED_DEVICE_DAYS = 90;
const OTP_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;

interface UserCredentialRow extends Record<string, unknown> {
  accountStatus: string;
  credentialId: number;
  deviceId?: string;
  email: string;
  failedAttempts: number;
  mobile: string;
  passwordHash: string;
  passwordSalt: string;
  userId: number;
}

interface LoginChallengeRow extends Record<string, unknown> {
  attempts: number;
  codeHash: string;
  deviceId: string;
  expiresAt: string;
  id: number;
  ipAddress: string | null;
  region: string | null;
  userId: number;
  verifiedAt: string | null;
}

interface StepUpChallengeRow extends Record<string, unknown> {
  attempts: number;
  codeHash: string;
  expiresAt: string;
  id: number;
  sessionId: number;
  userId: number;
  verifiedAt: string | null;
}

interface MobileRow extends Record<string, unknown> {
  mobile: string;
}

interface LogoutSessionRow extends Record<string, unknown> {
  sessionId: number;
  userId: number;
}

export interface AuthWriteOptions extends AuthenticateOptions {
  authenticate: (request: FastifyRequest) => Promise<AccessContext>;
  database?: DatabaseClient;
  sessionSigningKey?: string;
  otpSealing?: OtpSealingConfig;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signingKey(options: AuthWriteOptions): string {
  const value = options.sessionSigningKey?.trim();
  if (value === undefined || value.length < 32) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return value;
}

function sealedCode(options: AuthWriteOptions, code: string): Record<string, string> {
  if (options.otpSealing === undefined) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return sealOtp(options.otpSealing, code);
}

function database(options: AuthWriteOptions): DatabaseClient {
  if (options.database === undefined) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return options.database;
}

function now(options: AuthWriteOptions): Date {
  const value = options.now?.() ?? new Date();
  if (Number.isNaN(value.getTime())) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return value;
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value, true);
}

function credential(row: UserCredentialRow | undefined): UserCredentialRow {
  if (row === undefined) {
    throw new PlatformError(401, "UNAUTHORIZED", "Account or password is invalid");
  }
  return {
    ...row,
    userId: integer(row.userId),
    credentialId: integer(row.credentialId),
    email: text(row.email),
    mobile: text(row.mobile, true),
    accountStatus: text(row.accountStatus),
    passwordHash: text(row.passwordHash),
    passwordSalt: text(row.passwordSalt),
    failedAttempts:
      typeof row.failedAttempts === "number" &&
      Number.isSafeInteger(row.failedAttempts) &&
      row.failedAttempts >= 0
        ? row.failedAttempts
        : integer(undefined),
  };
}

async function readCredential(
  executor: QueryExecutor,
  account: string,
  lock = false,
): Promise<UserCredentialRow> {
  const rows = await executor.query<UserCredentialRow>(
    `SELECT
       users.id AS userId, users.email, users.mobile,
       users.account_status AS accountStatus,
       credentials.id AS credentialId,
       credentials.password_hash AS passwordHash,
       credentials.password_salt AS passwordSalt,
       credentials.failed_attempts AS failedAttempts
     FROM users
     INNER JOIN auth_credentials AS credentials ON credentials.user_id = users.id
     WHERE users.email = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [account],
  );
  return credential(rows[0]);
}

async function passwordHash(password: string, saltHex: string): Promise<string> {
  if (!/^[a-f\d]{32}$/iu.test(saltHex)) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  const derived = await pbkdf2(
    password,
    Buffer.from(saltHex, "hex"),
    210_000,
    32,
    "sha256",
  );
  return derived.toString("hex");
}

function requestIp(request: FastifyRequest): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() ?? null;
  const realIp = request.headers["x-real-ip"];
  return typeof realIp === "string" ? realIp : null;
}

function requestRegion(request: FastifyRequest): string | null {
  const value = request.headers["x-topology-region"] ?? request.headers["cf-ipcountry"];
  return typeof value === "string" && value.length <= 100 ? value : null;
}

function sessionToken(request: FastifyRequest): string {
  const header = request.headers.cookie;
  if (header === undefined || header.length > 8_192) {
    throw new PlatformError(401, "UNAUTHORIZED", "Authenticated session required");
  }
  const values = header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === "topology_session"
      ? [part.slice(separator + 1).trim()]
      : [];
  });
  const token = values.length === 1 ? values[0] : undefined;
  if (token === undefined || !/^[a-f\d]{64}$/iu.test(token)) {
    throw new PlatformError(401, "UNAUTHORIZED", "Authenticated session required");
  }
  return token;
}

async function logoutSession(
  executor: QueryExecutor,
  request: FastifyRequest,
): Promise<{ sessionId: number; userId: number }> {
  const rows = await executor.query<LogoutSessionRow>(
    `SELECT id AS sessionId, user_id AS userId
     FROM auth_sessions WHERE token_hash = ? LIMIT 1`,
    [sha256(sessionToken(request))],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new PlatformError(401, "UNAUTHORIZED", "Authenticated session required");
  }
  return { sessionId: integer(row.sessionId), userId: integer(row.userId) };
}

export function deriveOtpCode(key: string, command: string, principal: string, idempotencyKey: string): string {
  const digest = createHmac("sha256", key)
    .update(`otp:${command}:${principal}:${idempotencyKey}`, "utf8")
    .digest();
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += String((digest[index] ?? 0) % 10);
  }
  return code;
}

export function deriveChallengeNumber(prefix: string, key: string, principal: string, idempotencyKey: string): string {
  return `${prefix}-${createHmac("sha256", key)
    .update(`challenge:${prefix}:${principal}:${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function maskMobile(mobile: string): string {
  return mobile.length === 11
    ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}`
    : "";
}

function isPreview(options: AuthWriteOptions): boolean {
  if (options.environment?.cookieSecure === false) return false;
  const environment = options.environment;
  return ![environment?.appEnv, environment?.deployTarget, environment?.nodeEnv]
    .some((value) => value?.trim().toLowerCase() === "production" || value?.trim().toLowerCase() === "aliyun");
}

async function insertSession(
  transaction: QueryExecutor,
  input: {
    deviceId: string;
    ipAddress: string | null;
    region: string | null;
    token: string;
    userId: number;
    now: Date;
  },
): Promise<string> {
  const expiresAt = new Date(input.now.getTime() + SESSION_SECONDS * 1000).toISOString();
  const inserted = await transaction.execute(
    `INSERT INTO auth_sessions (
       user_id, token_hash, device_id, ip_address, region, expires_at,
       created_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [
      input.userId,
      sha256(input.token),
      input.deviceId,
      input.ipAddress,
      input.region,
      expiresAt,
    ],
  );
  if (inserted.affectedRows !== 1) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Authentication unavailable");
  }
  return expiresAt;
}

async function audit(
  transaction: QueryExecutor,
  userId: number,
  action: string,
  request: FastifyRequest,
  at: Date,
  after?: unknown,
): Promise<void> {
  await createAuditWriter({ database: transaction, now: () => at })({
    access: { localPreview: false, userId },
    action,
    module: "identity",
    entityType: "session",
    entityId: String(userId),
    request,
    ...(after === undefined ? {} : { after }),
  });
}

function loginChallenge(row: LoginChallengeRow | undefined): LoginChallengeRow {
  if (row === undefined) {
    throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
  }
  return {
    ...row,
    id: integer(row.id),
    userId: integer(row.userId),
    deviceId: text(row.deviceId),
    codeHash: text(row.codeHash),
    attempts:
      typeof row.attempts === "number" && Number.isSafeInteger(row.attempts)
        ? row.attempts
        : integer(undefined),
    expiresAt: text(row.expiresAt),
    ipAddress: nullableText(row.ipAddress),
    region: nullableText(row.region),
    verifiedAt: nullableText(row.verifiedAt),
  };
}

async function readLoginChallenge(
  executor: QueryExecutor,
  challengeNo: string,
  lock = false,
): Promise<LoginChallengeRow> {
  const rows = await executor.query<LoginChallengeRow>(
    `SELECT id, user_id AS userId, code_hash AS codeHash, device_id AS deviceId,
            ip_address AS ipAddress, region, expires_at AS expiresAt,
            attempts, verified_at AS verifiedAt
     FROM auth_challenges
     WHERE challenge_no = ? AND purpose = 'login'
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [challengeNo],
  );
  return loginChallenge(rows[0]);
}

async function registerLoginRoutes(
  app: FastifyInstance,
  options: AuthWriteOptions,
): Promise<void> {
  app.post<{
    Body: { account: string; password: string; deviceId: string; deviceName?: string };
  }>(
    "/api/v1/auth/login",
    {
      schema: {
        tags: ["authentication"],
        summary: "Authenticate with password and trusted-device policy",
        headers: commandHeadersSchema,
        body: loginCommandSchema,
        response: { 200: commandResponseSchema, 202: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      const db = database(options);
      const key = signingKey(options);
      const body = request.body;
      const account = body.account.trim().toLowerCase();
      const payload = { ...body, account } satisfies JsonValue;
      const at = now(options);
      const token = deriveSessionToken(
        key,
        "auth.login",
        sha256(account),
        readIdempotencyKey(request),
      );
      const response = await executeCommand({
        actorScope: `account:${sha256(account)}`,
        command: "auth.login",
        database: db,
        payload,
        request,
        responseStatus: 200,
        run: async ({ transaction }) => {
          const current = await readCredential(transaction, account, true);
          const matches =
            (await passwordHash(body.password, current.passwordSalt)) ===
            current.passwordHash;
          if (!matches) {
            const nextAttempts = Math.min(current.failedAttempts + 1, MAX_ATTEMPTS);
            await transaction.execute(
              `UPDATE auth_credentials
               SET failed_attempts = ?, locked_at = CASE WHEN ? >= ? THEN ? ELSE locked_at END,
                   updated_at = CURRENT_TIMESTAMP(3)
               WHERE id = ?`,
              [nextAttempts, nextAttempts, MAX_ATTEMPTS, at.toISOString(), current.credentialId],
            );
            if (nextAttempts >= MAX_ATTEMPTS) {
              await transaction.execute(
                `UPDATE users SET account_status = 'locked', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE id = ? AND account_status = 'active'`,
                [current.userId],
              );
            }
            await audit(transaction, current.userId, "login_failed", request, at, { attempts: nextAttempts });
            return { authenticated: false, locked: nextAttempts >= MAX_ATTEMPTS };
          }
          if (current.accountStatus !== "active") {
            throw new PlatformError(409, "CONFLICT", "Account state changed");
          }
          await transaction.execute(
            `UPDATE auth_credentials
             SET failed_attempts = 0, locked_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND failed_attempts < ?`,
            [current.credentialId, MAX_ATTEMPTS],
          );
          const deviceRows = await transaction.query<Record<string, unknown>>(
            `SELECT id FROM trusted_devices
             WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL
               AND trusted_until > ? AND (last_region IS NULL OR last_region = ?)
             LIMIT 1 FOR UPDATE`,
            [current.userId, body.deviceId, at.toISOString(), requestRegion(request)],
          );
          if (deviceRows[0] !== undefined) {
            const expiresAt = await insertSession(transaction, {
              deviceId: body.deviceId,
              ipAddress: requestIp(request),
              region: requestRegion(request),
              token,
              userId: current.userId,
              now: at,
            });
            await transaction.execute(
              `UPDATE trusted_devices
               SET last_ip_address = ?, last_region = ?, last_used_at = CURRENT_TIMESTAMP(3),
                   updated_at = CURRENT_TIMESTAMP(3)
               WHERE id = ?`,
              [requestIp(request), requestRegion(request), integer(deviceRows[0].id)],
            );
            await audit(transaction, current.userId, "login_succeeded", request, at);
            return { authenticated: true, expiresAt };
          }
          if (current.mobile.length !== 11) {
            throw new PlatformError(409, "CONFLICT", "Account has no valid mobile binding");
          }
          const idempotencyKey = readIdempotencyKey(request);
          const principal = `user:${current.userId}`;
          const code = deriveOtpCode(key, "auth.login", principal, idempotencyKey);
          const challengeNo = deriveChallengeNumber("OTP", key, principal, idempotencyKey);
          const expiresAt = new Date(at.getTime() + OTP_SECONDS * 1000).toISOString();
          await transaction.execute(
            `INSERT INTO auth_challenges (
               challenge_no, user_id, purpose, code_hash, device_id,
               ip_address, region, expires_at, attempts, created_at, updated_at
             ) VALUES (?, ?, 'login', ?, ?, ?, ?, ?, 0,
                       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [challengeNo, current.userId, sha256(`${challengeNo}:${code}`), body.deviceId,
              requestIp(request), requestRegion(request), expiresAt],
          );
          if (!isPreview(options)) {
            await enqueueOutbox(transaction, {
              topic: "sms.deliver",
              aggregateType: "auth_challenge",
              aggregateId: challengeNo,
              deduplicationKey: `sms:${challengeNo}`,
              payload: { mobile: current.mobile, sealedCode: sealedCode(options, code), purpose: "login" },
            });
          }
          await audit(transaction, current.userId, "login_otp_requested", request, at);
          return {
            authenticated: false,
            challengeNo,
            maskedMobile: maskMobile(current.mobile),
            ...(isPreview(options) ? { previewCode: code } : {}),
          };
        },
      });
      const result = response.body.result;
      if (result.locked !== undefined) {
        throw new PlatformError(
          result.locked === true ? 429 : 401,
          result.locked === true ? "TOO_MANY_REQUESTS" : "UNAUTHORIZED",
          result.locked === true ? "Account locked after repeated failures" : "Account or password is invalid",
        );
      }
      if (result.authenticated === true) {
        reply.header("set-cookie", sessionCookies(key, token, 12 * 60 * 60, options.environment?.cookieSecure ?? true));
      }
      return reply.status(response.statusCode).send(response.body);
    },
  );

  app.post<{ Body: { challengeNo: string; code: string; deviceName?: string } }>(
    "/api/v1/auth/verify",
    {
      schema: {
        tags: ["authentication"],
        summary: "Verify a one-time login challenge",
        headers: commandHeadersSchema,
        body: loginVerifyCommandSchema,
        response: { 200: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      const db = database(options);
      const key = signingKey(options);
      const initial = await readLoginChallenge(db, request.body.challengeNo);
      const valid = sha256(`${request.body.challengeNo}:${request.body.code}`) === initial.codeHash;
      const token = deriveSessionToken(
        key,
        "auth.verify",
        sha256(request.body.challengeNo),
        readIdempotencyKey(request),
      );
      const at = now(options);
      const response = await executeCommand({
        actorScope: `challenge:${sha256(request.body.challengeNo)}`,
        command: "auth.verify",
        database: db,
        payload: request.body,
        request,
        responseStatus: 200,
        run: async ({ transaction }) => {
          const challenge = await readLoginChallenge(transaction, request.body.challengeNo, true);
          if (challenge.verifiedAt !== null || challenge.expiresAt <= at.toISOString()) {
            throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
          }
          if (challenge.attempts >= MAX_ATTEMPTS) {
            throw new PlatformError(429, "OTP_ATTEMPTS_EXCEEDED", "Verification attempts exceeded");
          }
          if (!valid) {
            await transaction.execute(
              `UPDATE auth_challenges SET attempts = attempts + 1,
                   updated_at = CURRENT_TIMESTAMP(3)
               WHERE id = ? AND verified_at IS NULL AND attempts < ?`,
              [challenge.id, MAX_ATTEMPTS],
            );
            await audit(transaction, challenge.userId, "login_otp_failed", request, at);
            return { authenticated: false };
          }
          const claimed = await transaction.execute(
            `UPDATE auth_challenges SET verified_at = ?, consumed_at = ?,
                 updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND verified_at IS NULL AND attempts < ? AND expires_at > ?`,
            [at.toISOString(), at.toISOString(), challenge.id, MAX_ATTEMPTS, at.toISOString()],
          );
          if (claimed.affectedRows !== 1) {
            throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
          }
          const trustedUntil = new Date(at.getTime() + TRUSTED_DEVICE_DAYS * 86_400_000).toISOString();
          await transaction.execute(
            `INSERT INTO trusted_devices (
               user_id, device_id, device_name, last_ip_address, last_region,
               trusted_until, revoked_at, last_used_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP(3),
                       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
             ON DUPLICATE KEY UPDATE device_name = VALUES(device_name),
               last_ip_address = VALUES(last_ip_address), last_region = VALUES(last_region),
               trusted_until = VALUES(trusted_until), revoked_at = NULL,
               last_used_at = VALUES(last_used_at), updated_at = VALUES(updated_at)`,
            [challenge.userId, challenge.deviceId, request.body.deviceName ?? "",
              challenge.ipAddress, challenge.region, trustedUntil],
          );
          const expiresAt = await insertSession(transaction, {
            deviceId: challenge.deviceId,
            ipAddress: challenge.ipAddress,
            region: challenge.region,
            token,
            userId: challenge.userId,
            now: at,
          });
          await audit(transaction, challenge.userId, "login_otp_succeeded", request, at);
          return { authenticated: true, trustedUntil, expiresAt };
        },
      });
      if (response.body.result.authenticated !== true) {
        throw new PlatformError(401, "UNAUTHORIZED", "Verification code is invalid");
      }
      if (response.body.result.authenticated === true) {
        reply.header("set-cookie", sessionCookies(key, token, 12 * 60 * 60, options.environment?.cookieSecure ?? true));
      }
      return reply.status(response.statusCode).send(response.body);
    },
  );
}

async function registerSessionRoutes(
  app: FastifyInstance,
  options: AuthWriteOptions,
): Promise<void> {
  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        tags: ["authentication"],
        summary: "Revoke the current authenticated session",
        headers: commandHeadersSchema,
        response: { 200: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const db = database(options);
      const access = await logoutSession(db, request);
      const at = now(options);
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "auth.logout",
        database: db,
        payload: {},
        request,
        run: async ({ transaction }) => {
          await transaction.execute(
            `UPDATE auth_sessions SET revoked_at = ?
             WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
            [at.toISOString(), access.sessionId, access.userId],
          );
          await audit(transaction, access.userId, "logout", request, at);
          return { success: true };
        },
      });
      reply.header("set-cookie", clearSessionCookies(options.environment?.cookieSecure ?? true));
      return reply.status(response.statusCode).send(response.body);
    },
  );
}

async function registerStepUpRoutes(
  app: FastifyInstance,
  options: AuthWriteOptions,
): Promise<void> {
  app.post<{
    Body: { action: string; objectType: string; objectId: string; objectVersion: number; requestDigest?: string };
  }>(
    "/api/v1/auth/step-up/request",
    {
      schema: {
        tags: ["authentication"],
        summary: "Request a session and object-bound step-up challenge",
        headers: commandHeadersSchema,
        body: stepUpRequestCommandSchema,
        response: { 201: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      if (access.localPreview || access.sessionId === null) {
        throw new PlatformError(403, "FORBIDDEN", "Authenticated session required");
      }
      const db = database(options);
      const key = signingKey(options);
      const at = now(options);
      const idempotencyKey = readIdempotencyKey(request);
      const principal = `user:${access.userId}:session:${access.sessionId}`;
      const code = deriveOtpCode(key, "step-up.request", principal, idempotencyKey);
      const challengeNo = deriveChallengeNumber("HR", key, principal, idempotencyKey);
      if (request.body.requestDigest === undefined) {
        throw new PlatformError(400, "BAD_REQUEST", "Final request digest is required");
      }
      const bindingDigest = request.body.requestDigest.toLowerCase();
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "step-up.request",
        database: db,
        payload: request.body,
        request,
        responseStatus: 201,
        run: async ({ transaction }) => {
          const mobileRows = await transaction.query<MobileRow>(
            `SELECT mobile FROM users WHERE id = ? AND account_status = 'active' LIMIT 1 FOR UPDATE`,
            [access.userId],
          );
          const mobile = text(mobileRows[0]?.mobile, true);
          if (mobile.length !== 11) {
            throw new PlatformError(409, "CONFLICT", "Account has no valid mobile binding");
          }
          const expiresAt = new Date(at.getTime() + OTP_SECONDS * 1000).toISOString();
          await transaction.execute(
            `INSERT INTO auth_challenges (
               challenge_no, user_id, purpose, code_hash, device_id, expires_at,
               attempts, session_id, action, object_type, object_id, object_version,
               request_digest, created_at, updated_at
             ) VALUES (?, ?, 'high_risk', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?,
                       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
            [challengeNo, access.userId, sha256(`${challengeNo}:${code}`),
              `${request.body.objectType}:${request.body.objectId}`, expiresAt,
              access.sessionId, request.body.action, request.body.objectType,
              request.body.objectId, request.body.objectVersion, bindingDigest],
          );
          if (!isPreview(options)) {
            await enqueueOutbox(transaction, {
              topic: "sms.deliver",
              aggregateType: "auth_challenge",
              aggregateId: challengeNo,
              deduplicationKey: `sms:${challengeNo}`,
              payload: { mobile, sealedCode: sealedCode(options, code), purpose: "high-risk" },
            });
          }
          await audit(transaction, access.userId, "step_up_requested", request, at, {
            action: request.body.action,
            objectType: request.body.objectType,
            objectId: request.body.objectId,
            objectVersion: request.body.objectVersion,
            requestDigest: bindingDigest,
          });
          return {
            challengeNo,
            expiresInSeconds: OTP_SECONDS,
            mobile: maskMobile(mobile),
            requestDigest: bindingDigest,
            ...(isPreview(options) ? { previewCode: code } : {}),
          };
        },
      });
      return reply.status(response.statusCode).send(response.body);
    },
  );

  app.post<{ Body: { challengeNo: string; code: string } }>(
    "/api/v1/auth/step-up/verify",
    {
      schema: {
        tags: ["authentication"],
        summary: "Verify a session-bound step-up challenge",
        headers: commandHeadersSchema,
        body: stepUpVerifyCommandSchema,
        response: { 200: commandResponseSchema, "4xx": { $ref: `${apiErrorSchemaId}#` }, 503: { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      if (access.localPreview || access.sessionId === null) {
        throw new PlatformError(403, "FORBIDDEN", "Authenticated session required");
      }
      const db = database(options);
      const rows = await db.query<StepUpChallengeRow>(
        `SELECT id, user_id AS userId, session_id AS sessionId,
                code_hash AS codeHash, expires_at AS expiresAt,
                attempts, verified_at AS verifiedAt
         FROM auth_challenges
         WHERE challenge_no = ? AND purpose = 'high_risk' LIMIT 1`,
        [request.body.challengeNo],
      );
      const initial = rows[0];
      if (initial === undefined || integer(initial.userId) !== access.userId || integer(initial.sessionId) !== access.sessionId) {
        throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
      }
      const valid = sha256(`${request.body.challengeNo}:${request.body.code}`) === text(initial.codeHash);
      const at = now(options);
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "step-up.verify",
        database: db,
        payload: request.body,
        request,
        responseStatus: 200,
        run: async ({ transaction }) => {
          const locked = await transaction.query<StepUpChallengeRow>(
            `SELECT id, user_id AS userId, session_id AS sessionId,
                    code_hash AS codeHash, expires_at AS expiresAt,
                    attempts, verified_at AS verifiedAt
             FROM auth_challenges
             WHERE challenge_no = ? AND purpose = 'high_risk' LIMIT 1 FOR UPDATE`,
            [request.body.challengeNo],
          );
          const challenge = locked[0];
          if (
            challenge === undefined ||
            integer(challenge.userId) !== access.userId ||
            integer(challenge.sessionId) !== access.sessionId ||
            nullableText(challenge.verifiedAt) !== null ||
            text(challenge.expiresAt) <= at.toISOString()
          ) {
            throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
          }
          if (integer(challenge.attempts + 1) > MAX_ATTEMPTS) {
            throw new PlatformError(429, "OTP_ATTEMPTS_EXCEEDED", "Verification attempts exceeded");
          }
          if (!valid) {
            await transaction.execute(
              `UPDATE auth_challenges SET attempts = attempts + 1,
                   updated_at = CURRENT_TIMESTAMP(3)
               WHERE id = ? AND attempts < ? AND verified_at IS NULL`,
              [integer(challenge.id), MAX_ATTEMPTS],
            );
            await audit(transaction, access.userId, "step_up_failed", request, at);
            return { verified: false };
          }
          const claimed = await transaction.execute(
            `UPDATE auth_challenges SET verified_at = ?, updated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ? AND attempts < ? AND verified_at IS NULL AND expires_at > ?`,
            [at.toISOString(), integer(challenge.id), MAX_ATTEMPTS, at.toISOString()],
          );
          if (claimed.affectedRows !== 1) {
            throw new PlatformError(409, "OTP_EXPIRED", "Verification challenge is invalid or expired");
          }
          await audit(transaction, access.userId, "step_up_verified", request, at);
          return { verified: true, challengeNo: request.body.challengeNo };
        },
      });
      if (response.body.result.verified !== true) {
        throw new PlatformError(401, "UNAUTHORIZED", "Verification code is invalid");
      }
      return reply.status(response.statusCode).send(response.body);
    },
  );
}

export async function registerAuthWriteRoutes(
  app: FastifyInstance,
  options: AuthWriteOptions,
): Promise<void> {
  await registerLoginRoutes(app, options);
  await registerSessionRoutes(app, options);
  await registerStepUpRoutes(app, options);
}
