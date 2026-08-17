import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";

import { createDatabaseClient } from "../dist/infrastructure/database.js";
import { buildRuntimeApp } from "../dist/runtime.js";

const databaseUrl = process.env.MYSQL_WRITE_TEST_URL?.trim();
const signingKey = "scope-a-route-integration-signing-key-0001";

function otp(command, principal, idempotencyKey) {
  const digest = createHmac("sha256", signingKey)
    .update(`otp:${command}:${principal}:${idempotencyKey}`, "utf8")
    .digest();
  return Array.from({ length: 6 }, (_, index) => String((digest[index] ?? 0) % 10)).join("");
}

function platformHeaders(idempotencyKey, extras = {}) {
  return {
    host: "scm.topologygz.com",
    origin: "https://scm.topologygz.com",
    "x-forwarded-host": "scm.topologygz.com",
    "x-forwarded-proto": "https",
    "idempotency-key": idempotencyKey,
    ...extras,
  };
}

function cookiePair(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const pairs = values.filter(Boolean).map((value) => value.split(";", 1)[0]);
  return {
    cookie: pairs.join("; "),
    csrf: pairs.find((value) => value.startsWith("topology_csrf="))?.split("=", 2)[1],
  };
}

function multipart(boundary, bytes, entityId, contentType = "application/pdf") {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\ninvoice\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\npurchase_order\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${entityId}\r\n--${boundary}--\r\n`),
  ]);
}

test("MySQL-backed v1 platform routes enforce auth, OTP, CSRF, idempotency, scope, and quarantine", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Scope A route integration",
  timeout: 60_000,
}, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const db = createDatabaseClient({
    env: {
      DATABASE_URL: databaseUrl,
      DB_SSL: "disabled",
      DB_POOL_SIZE: "20",
      DB_QUERY_TIMEOUT_MS: "30000",
    },
  });
  const stored = new Map();
  let storageReads = 0;
  const app = await buildRuntimeApp({
    database: db,
    environment: {
      APP_ENV: "production",
      API_SESSION_SIGNING_KEY: signingKey,
      OTP_SEALING_KEY_ID: "integration-v1",
      OTP_SEALING_KEY: "22".repeat(32),
      DEPLOY_TARGET: "aliyun",
      NODE_ENV: "production",
    },
    fileStorage: {
      async deleteObject(key) { stored.delete(key); },
      async readObject(key) { storageReads += 1; return stored.get(key) ?? null; },
      async writeQuarantinedObject(key, body) { stored.set(key, Uint8Array.from(body)); },
    },
    fileScannerReady: async () => undefined,
    logger: false,
  });
  t.after(async () => { await app.close(); await db.close(); });
  await db.execute(
    `UPDATE writer_fences SET enabled = 1, generation = 2
     WHERE resource IN ('auth.commands','users.commands','files.commands','notifications.commands')`,
  );

  const salt = randomBytes(16).toString("hex");
  const password = "correct horse battery staple";
  const passwordHash = pbkdf2Sync(password, Buffer.from(salt, "hex"), 210_000, 32, "sha256").toString("hex");
  const adminInsert = await db.execute(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, '13800138001', 'Route Admin', 'supply_chain', 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`route-admin-${suffix}@example.com`],
  );
  const adminId = adminInsert.insertId;
  assert.ok(adminId);
  await db.execute(
    `INSERT INTO auth_credentials (user_id, password_hash, password_salt, failed_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [adminId, passwordHash, salt],
  );
  await db.execute(
    `INSERT INTO user_roles (user_id, role_code, effective_from, status, requested_by, created_at, updated_at)
     VALUES (?, 'admin', '2026-01-01', 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [adminId, adminId],
  );
  const targetInsert = await db.execute(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, '13800138002', 'Route Target', 'finance', 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`route-target-${suffix}@example.com`],
  );
  const targetId = targetInsert.insertId;
  assert.ok(targetId);

  const originRejected = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "scm.topologygz.com", "idempotency-key": `origin-${suffix}` },
    payload: { account: `route-admin-${suffix}@example.com`, password, deviceId: `device-${suffix}` },
  });
  assert.equal(originRejected.statusCode, 403);
  assert.equal(originRejected.json().code, "ORIGIN_REJECTED");

  const badPasswordKey = `bad-password-${suffix}`;
  const badPassword = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(badPasswordKey),
    payload: { account: `route-admin-${suffix}@example.com`, password: "wrong", deviceId: `device-${suffix}` },
  });
  const badPasswordReplay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(badPasswordKey),
    payload: { account: `route-admin-${suffix}@example.com`, password: "wrong", deviceId: `device-${suffix}` },
  });
  assert.equal(badPassword.statusCode, 401);
  assert.equal(badPasswordReplay.statusCode, 401);
  const [attempts] = await db.query(
    "SELECT failed_attempts AS attempts FROM auth_credentials WHERE user_id = ?",
    [adminId],
  );
  assert.equal(attempts.attempts, 1);

  const loginKey = `login-route-${suffix}`;
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(loginKey),
    payload: { account: `route-admin-${suffix}@example.com`, password, deviceId: `device-${suffix}`, deviceName: "integration" },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().result.authenticated, false);
  const challengeNo = login.json().result.challengeNo;
  const loginReplay = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(loginKey),
    payload: { account: `route-admin-${suffix}@example.com`, password, deviceId: `device-${suffix}`, deviceName: "integration" },
  });
  assert.equal(loginReplay.json().command.replayed, true);
  assert.equal(loginReplay.json().result.challengeNo, challengeNo);

  const badOtpKey = `bad-otp-${suffix}`;
  const correctLoginOtp = otp("auth.login", `user:${adminId}`, loginKey);
  const [sealedSms] = await db.query(
    `SELECT payload_json AS payloadJson FROM outbox_messages
     WHERE topic = 'sms.deliver' AND aggregate_id = ?`,
    [challengeNo],
  );
  assert.doesNotMatch(sealedSms.payloadJson, new RegExp(correctLoginOtp, "u"));
  assert.match(sealedSms.payloadJson, /sealedCode/u);
  const wrongLoginOtp = `${(Number(correctLoginOtp[0]) + 1) % 10}${correctLoginOtp.slice(1)}`;
  for (let index = 0; index < 2; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      headers: platformHeaders(badOtpKey),
      payload: { challengeNo, code: wrongLoginOtp },
    });
    assert.equal(response.statusCode, 401);
  }
  const [otpAttempts] = await db.query(
    "SELECT attempts FROM auth_challenges WHERE challenge_no = ?",
    [challengeNo],
  );
  assert.equal(otpAttempts.attempts, 1);

  const verifyKey = `verify-route-${suffix}`;
  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: platformHeaders(verifyKey),
    payload: { challengeNo, code: correctLoginOtp, deviceName: "integration" },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().result.authenticated, true);
  const cookies = cookiePair(verified.headers["set-cookie"]);
  assert.match(cookies.cookie, /topology_session=/u);
  assert.match(cookies.csrf, /^[a-f\d]{64}$/u);

  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/v1/auth/step-up/request",
    headers: platformHeaders(`missing-csrf-${suffix}`, { cookie: cookies.cookie }),
    payload: { action: "approve", objectType: "approval", objectId: "9", objectVersion: 1, requestDigest: "a".repeat(64) },
  });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(missingCsrf.json().code, "CSRF_REJECTED");

  const authenticated = (key, extras = {}) => platformHeaders(key, {
    cookie: cookies.cookie,
    "x-csrf-token": cookies.csrf,
    ...extras,
  });
  const stepKey = `step-request-${suffix}`;
  const step = await app.inject({
    method: "POST",
    url: "/api/v1/auth/step-up/request",
    headers: authenticated(stepKey),
    payload: { action: "approve", objectType: "approval", objectId: "9", objectVersion: 1, requestDigest: "a".repeat(64) },
  });
  assert.equal(step.statusCode, 201);
  const stepChallenge = step.json().result.challengeNo;
  const [issuedBinding] = await db.query(
    "SELECT session_id AS sessionId FROM auth_challenges WHERE challenge_no = ?",
    [stepChallenge],
  );
  const stepVerifyKey = `step-verify-${suffix}`;
  const stepVerified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/step-up/verify",
    headers: authenticated(stepVerifyKey),
    payload: { challengeNo: stepChallenge, code: otp("step-up.request", `user:${adminId}:session:${issuedBinding.sessionId}`, stepKey) },
  });
  assert.equal(stepVerified.statusCode, 200);
  const [binding] = await db.query(
    `SELECT session_id AS sessionId, action, object_type AS objectType,
            object_id AS objectId, object_version AS objectVersion,
            request_digest AS requestDigest, verified_at AS verifiedAt
     FROM auth_challenges WHERE challenge_no = ?`,
    [stepChallenge],
  );
  assert.equal(binding.action, "approve");
  assert.equal(binding.objectType, "approval");
  assert.equal(binding.objectId, "9");
  assert.equal(binding.objectVersion, 1);
  assert.match(binding.requestDigest, /^[a-f\d]{64}$/u);
  assert.ok(binding.verifiedAt);
  assert.equal(binding.requestDigest, "a".repeat(64));

  const roleKey = `assign-role-${suffix}`;
  const rolePayload = {
    userId: targetId,
    roleCode: "receiver",
    effectiveFrom: "2026-08-12",
    effectiveTo: null,
    reason: "integration coverage",
  };
  const role = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: authenticated(roleKey),
    payload: rolePayload,
  });
  assert.equal(role.statusCode, 201);
  const roleReplay = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: authenticated(roleKey),
    payload: rolePayload,
  });
  assert.equal(roleReplay.statusCode, 201);
  assert.equal(roleReplay.json().command.replayed, true);
  const [roleCounts] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM user_roles WHERE user_id = ? AND role_code = 'receiver') AS roles,
       (SELECT COUNT(*) FROM approval_requests WHERE entity_type = 'user_role' AND requested_by = ?) AS approvals`,
    [targetId, adminId],
  );
  assert.equal(roleCounts.roles, 1);
  assert.equal(roleCounts.approvals, 1);

  const managedEmail = `managed-${suffix}@example.com`;
  const managedInitialPassword = "InitialUser!234";
  const managedResetPassword = "ReplacementUser!567";
  const managedDeviceId = `managed-device-${suffix}`;
  const createAccountKey = `create-account-${suffix}`;
  const createAccountPayload = {
    email: managedEmail,
    initialPassword: managedInitialPassword,
    mobile: "13900139001",
    name: "Managed Receiver",
    organizationName: "Topology Receiver",
    roleCode: "receiver",
  };
  const createdAccount = await app.inject({
    method: "POST",
    url: "/api/v1/users/accounts",
    headers: authenticated(createAccountKey),
    payload: createAccountPayload,
  });
  assert.equal(createdAccount.statusCode, 201, createdAccount.body);
  assert.equal(createdAccount.json().result.roleCode, "receiver");
  const managedUserId = createdAccount.json().result.userId;
  assert.ok(managedUserId);
  const createdAccountReplay = await app.inject({
    method: "POST",
    url: "/api/v1/users/accounts",
    headers: authenticated(createAccountKey),
    payload: createAccountPayload,
  });
  assert.equal(createdAccountReplay.statusCode, 201);
  assert.equal(createdAccountReplay.json().command.replayed, true);
  assert.equal(createdAccountReplay.json().result.userId, managedUserId);

  const [createdState] = await db.query(
    `SELECT users.role, users.account_status AS accountStatus,
            credentials.password_hash AS passwordHash,
            credentials.password_salt AS passwordSalt,
            (SELECT COUNT(*) FROM user_roles WHERE user_id = users.id) AS delegatedRoles
     FROM users
     INNER JOIN auth_credentials AS credentials ON credentials.user_id = users.id
     WHERE users.id = ?`,
    [managedUserId],
  );
  assert.equal(createdState.role, "receiver");
  assert.equal(createdState.accountStatus, "active");
  assert.equal(createdState.delegatedRoles, 0);
  assert.match(createdState.passwordHash, /^[a-f\d]{64}$/u);
  assert.match(createdState.passwordSalt, /^[a-f\d]{32}$/u);
  assert.notEqual(createdState.passwordHash, managedInitialPassword);

  const managedLoginKey = `managed-login-${suffix}`;
  const managedLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(managedLoginKey),
    payload: {
      account: managedEmail,
      password: managedInitialPassword,
      deviceId: managedDeviceId,
      deviceName: "managed integration",
    },
  });
  assert.equal(managedLogin.statusCode, 200);
  assert.equal(managedLogin.json().result.authenticated, false);
  const managedChallengeNo = managedLogin.json().result.challengeNo;
  const managedVerify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/verify",
    headers: platformHeaders(`managed-verify-${suffix}`),
    payload: {
      challengeNo: managedChallengeNo,
      code: otp("auth.login", `user:${managedUserId}`, managedLoginKey),
      deviceName: "managed integration",
    },
  });
  assert.equal(managedVerify.statusCode, 200);
  assert.equal(managedVerify.json().result.authenticated, true);
  const managedCookies = cookiePair(managedVerify.headers["set-cookie"]);
  const managedAuthenticated = (key, extras = {}) => platformHeaders(key, {
    cookie: managedCookies.cookie,
    "x-csrf-token": managedCookies.csrf,
    ...extras,
  });

  const managedSession = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: managedCookies.cookie },
  });
  assert.equal(managedSession.statusCode, 200);
  assert.deepEqual(managedSession.json().user.roles, ["receiver"]);

  const nonAdminRejected = await app.inject({
    method: "POST",
    url: "/api/v1/users/disable",
    headers: managedAuthenticated(`managed-forbidden-${suffix}`),
    payload: { userId: adminId },
  });
  assert.equal(nonAdminRejected.statusCode, 403);
  assert.equal(nonAdminRejected.json().code, "FORBIDDEN");

  const disableKey = `disable-managed-${suffix}`;
  const disabled = await app.inject({
    method: "POST",
    url: "/api/v1/users/disable",
    headers: authenticated(disableKey),
    payload: { userId: managedUserId },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().result.accountStatus, "disabled");
  assert.equal(disabled.json().result.activeSessionsRevoked, true);
  const disabledReplay = await app.inject({
    method: "POST",
    url: "/api/v1/users/disable",
    headers: authenticated(disableKey),
    payload: { userId: managedUserId },
  });
  assert.equal(disabledReplay.statusCode, 200);
  assert.equal(disabledReplay.json().command.replayed, true);

  const disabledSession = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: managedCookies.cookie },
  });
  assert.equal(disabledSession.statusCode, 401);
  const disabledLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(`disabled-login-${suffix}`),
    payload: {
      account: managedEmail,
      password: managedInitialPassword,
      deviceId: managedDeviceId,
    },
  });
  assert.equal(disabledLogin.statusCode, 409);

  const restored = await app.inject({
    method: "POST",
    url: "/api/v1/users/restore",
    headers: authenticated(`restore-managed-${suffix}`),
    payload: { userId: managedUserId },
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().result.accountStatus, "active");
  const restoredLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(`restored-login-${suffix}`),
    payload: {
      account: managedEmail,
      password: managedInitialPassword,
      deviceId: managedDeviceId,
    },
  });
  assert.equal(restoredLogin.statusCode, 200);
  assert.equal(restoredLogin.json().result.authenticated, true);
  const restoredCookies = cookiePair(restoredLogin.headers["set-cookie"]);

  const resetKey = `reset-managed-${suffix}`;
  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/users/password-reset",
    headers: authenticated(resetKey),
    payload: { userId: managedUserId, newPassword: managedResetPassword },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().result.activeSessionsRevoked, true);
  const resetReplay = await app.inject({
    method: "POST",
    url: "/api/v1/users/password-reset",
    headers: authenticated(resetKey),
    payload: { userId: managedUserId, newPassword: managedResetPassword },
  });
  assert.equal(resetReplay.statusCode, 200);
  assert.equal(resetReplay.json().command.replayed, true);

  const resetRevokedSession = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: restoredCookies.cookie },
  });
  assert.equal(resetRevokedSession.statusCode, 401);
  const oldPasswordRejected = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(`old-password-${suffix}`),
    payload: {
      account: managedEmail,
      password: managedInitialPassword,
      deviceId: managedDeviceId,
    },
  });
  assert.equal(oldPasswordRejected.statusCode, 401);
  const newPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: platformHeaders(`new-password-${suffix}`),
    payload: {
      account: managedEmail,
      password: managedResetPassword,
      deviceId: managedDeviceId,
    },
  });
  assert.equal(newPasswordLogin.statusCode, 200);
  assert.equal(newPasswordLogin.json().result.authenticated, true);
  const finalManagedCookies = cookiePair(newPasswordLogin.headers["set-cookie"]);
  const managedLogout = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: platformHeaders(`managed-logout-${suffix}`, {
      cookie: finalManagedCookies.cookie,
      "x-csrf-token": finalManagedCookies.csrf,
    }),
  });
  assert.equal(managedLogout.statusCode, 200);
  const managedAfterLogout = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: finalManagedCookies.cookie },
  });
  assert.equal(managedAfterLogout.statusCode, 401);

  const lifecycleAudit = await db.query(
    `SELECT action, before_json AS beforeJson, after_json AS afterJson
     FROM audit_logs
     WHERE actor_user_id = ? AND entity_type = 'user' AND entity_id = ?
       AND action IN ('create_account','disable_account','restore_account','reset_password')
     ORDER BY id`,
    [adminId, String(managedUserId)],
  );
  assert.deepEqual(lifecycleAudit.map((row) => row.action), [
    "create_account",
    "disable_account",
    "restore_account",
    "reset_password",
  ]);
  assert.doesNotMatch(JSON.stringify(lifecycleAudit),
    new RegExp(`${managedInitialPassword}|${managedResetPassword}`, "u"));
  const lifecycleCommands = await db.query(
    `SELECT command_name AS commandName, response_json AS responseJson
     FROM command_idempotency
     WHERE actor_scope = ?
       AND command_name IN ('users.create','users.disable','users.restore','users.reset-password')
     ORDER BY id`,
    [`user:${adminId}`],
  );
  assert.deepEqual(lifecycleCommands.map((row) => row.commandName), [
    "users.create",
    "users.disable",
    "users.restore",
    "users.reset-password",
  ]);
  assert.doesNotMatch(JSON.stringify(lifecycleCommands),
    new RegExp(`${managedInitialPassword}|${managedResetPassword}`, "u"));

  const notificationInsert = await db.execute(
    `INSERT INTO notification_messages (
       recipient_user_id, channel, type, severity, title, message,
       entity_type, entity_id, status, created_at
     ) VALUES (?, 'in_app', 'integration', 'normal', 'Title', 'Message',
               'user', ?, 'sent', CURRENT_TIMESTAMP(3))`,
    [adminId, targetId],
  );
  const notificationId = notificationInsert.insertId;
  const marked = await app.inject({
    method: "POST",
    url: "/api/v1/notifications/read",
    headers: authenticated(`notification-${suffix}`),
    payload: { id: notificationId },
  });
  assert.equal(marked.statusCode, 200);
  assert.equal(marked.json().result.status, "read");

  const orderInsert = await db.execute(
    `INSERT INTO purchase_orders (order_no, source, status, created_at, updated_at)
     VALUES (?, 'manual', 'draft', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`PO-FILE-${suffix}`],
  );
  const purchaseOrderId = orderInsert.insertId;

  const badBoundary = `bad-${suffix}`;
  const rejectedFile = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: authenticated(`file-bad-${suffix}`, {
      "content-type": `multipart/form-data; boundary=${badBoundary}`,
    }),
    payload: multipart(badBoundary, Buffer.from("not a pdf"), purchaseOrderId),
  });
  assert.equal(rejectedFile.statusCode, 415);
  assert.equal(rejectedFile.json().code, "FILE_TYPE_REJECTED");

  const boundary = `good-${suffix}`;
  const uploaded = await app.inject({
    method: "POST",
    url: "/api/v1/files",
    headers: authenticated(`file-good-${suffix}`, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    }),
    payload: multipart(boundary, Buffer.from("%PDF-1.7\nroute integration"), purchaseOrderId),
  });
  assert.equal(uploaded.statusCode, 201);
  assert.equal(uploaded.json().result.usable, false);
  assert.equal(uploaded.json().result.file.scanStatus, "quarantined");
  const fileId = uploaded.json().result.file.id;
  const quarantined = await app.inject({
    method: "GET",
    url: `/api/v1/files?id=${fileId}`,
    headers: { host: "scm.topologygz.com", cookie: cookies.cookie },
  });
  assert.equal(quarantined.statusCode, 423);
  assert.equal(quarantined.json().code, "FILE_QUARANTINED");
  assert.equal(storageReads, 0);

  const logoutKey = `logout-${suffix}`;
  for (let index = 0; index < 2; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authenticated(logoutKey),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().command.replayed, index === 1);
  }
  const afterLogout = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: cookies.cookie },
  });
  assert.equal(afterLogout.statusCode, 401);

  const malformedUser = await db.execute(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, '13800138003', 'Unbound Factory', 'factory', 'Broken', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`unbound-${suffix}@example.com`],
  );
  const malformedSessionToken = createHash("sha256").update(`malformed:${suffix}`).digest("hex");
  await db.execute(
    `INSERT INTO auth_sessions (user_id, token_hash, device_id, expires_at, created_at, last_seen_at)
     VALUES (?, SHA2(?, 256), 'broken', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [malformedUser.insertId, malformedSessionToken, new Date(Date.now() + 3_600_000).toISOString()],
  );
  const malformedBinding = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "scm.topologygz.com", cookie: `topology_session=${malformedSessionToken}` },
  });
  assert.equal(malformedBinding.statusCode, 403);
});
