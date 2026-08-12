import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createAuditWriter } from "../dist/infrastructure/audit.js";
import { createDatabaseClient, DatabaseClientError } from "../dist/infrastructure/database.js";
import { consumeStepUpClaim } from "../dist/platform/approvals.js";
import { executeCommand } from "../dist/platform/commands.js";
import { enqueueOutbox } from "../dist/platform/outbox.js";

const databaseUrl = process.env.MYSQL_WRITE_TEST_URL?.trim();

function request(idempotencyKey) {
  return { headers: { "idempotency-key": idempotencyKey } };
}

test("MySQL 8 write foundation is atomic, serialized, fenced, and replayable", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Scope A MySQL integration",
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
  t.after(() => db.close());

  const email = `scope-a-${suffix}@example.com`;
  const insertedUser = await db.execute(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status, created_at, updated_at
     ) VALUES (?, '13800138000', 'Scope A', 'supply_chain', 'Topology', 'active',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [email],
  );
  const userId = insertedUser.insertId;
  assert.ok(userId);

  const rollbackResource = `rollback-${suffix}`;
  await assert.rejects(
    db.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
         VALUES ('integration', ?, 1, CURRENT_TIMESTAMP(3))`,
        [rollbackResource],
      );
      await createAuditWriter({ database: transaction })({
        access: { localPreview: false, userId },
        action: "rollback_probe",
        module: "platform",
        entityType: "integration",
        entityId: rollbackResource,
      });
      await enqueueOutbox(transaction, {
        topic: "notification.dispatch",
        aggregateType: "integration",
        aggregateId: rollbackResource,
        deduplicationKey: `rollback:${suffix}`,
        payload: { approvalId: 1, recipientRole: "admin", type: "probe" },
      });
      throw new Error("inject rollback");
    }),
    /inject rollback/u,
  );
  const [rolledBackVersion] = await db.query(
    `SELECT COUNT(*) AS count FROM resource_versions
     WHERE resource_type = 'integration' AND resource_id = ?`,
    [rollbackResource],
  );
  const [rolledBackAudit] = await db.query(
    `SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ?`,
    [rollbackResource],
  );
  const [rolledBackOutbox] = await db.query(
    `SELECT COUNT(*) AS count FROM outbox_messages WHERE deduplication_key = ?`,
    [`rollback:${suffix}`],
  );
  assert.equal(rolledBackVersion.count, 0);
  assert.equal(rolledBackAudit.count, 0);
  assert.equal(rolledBackOutbox.count, 0);

  const key = `mysql-command-${suffix}`;
  const commandResource = `command-${suffix}`;
  let runs = 0;
  const commandOptions = {
    actorScope: `user:${userId}`,
    command: "notifications.mark-read",
    database: db,
    payload: { id: 77 },
    request: request(key),
    async run({ transaction }) {
      runs += 1;
      await transaction.execute(
        `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
         VALUES ('integration', ?, 1, CURRENT_TIMESTAMP(3))`,
        [commandResource],
      );
      await createAuditWriter({ database: transaction })({
        access: { localPreview: false, userId },
        action: "command_probe",
        module: "platform",
        entityType: "integration",
        entityId: commandResource,
      });
      await enqueueOutbox(transaction, {
        topic: "notification.dispatch",
        aggregateType: "integration",
        aggregateId: commandResource,
        deduplicationKey: `command:${suffix}`,
        payload: { approvalId: 1, recipientRole: "admin", type: "probe" },
      });
      await delay(150);
      return { success: true, resource: commandResource };
    },
  };
  const outcomes = await Promise.all([
    executeCommand(commandOptions),
    executeCommand(commandOptions),
  ]);
  assert.equal(runs, 1);
  assert.deepEqual(outcomes.map((value) => value.body.command.replayed).sort(), [false, true]);
  const [commandCounts] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM resource_versions WHERE resource_type = 'integration' AND resource_id = ?) AS versions,
       (SELECT COUNT(*) FROM audit_logs WHERE entity_id = ?) AS audits,
       (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key = ?) AS outboxRows,
       (SELECT COUNT(*) FROM command_idempotency WHERE idempotency_key = ?) AS commands`,
    [commandResource, commandResource, `command:${suffix}`, key],
  );
  assert.deepEqual(
    [commandCounts.versions, commandCounts.audits, commandCounts.outboxRows, commandCounts.commands],
    [1, 1, 1, 1],
  );
  await assert.rejects(
    executeCommand({ ...commandOptions, payload: { id: 78 } }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );

  const unknownKey = `mysql-unknown-${suffix}`;
  const unknownResource = `unknown-${suffix}`;
  let unknownRuns = 0;
  const unknownOptions = {
    ...commandOptions,
    payload: { id: 79 },
    request: request(unknownKey),
    async run({ transaction }) {
      unknownRuns += 1;
      await transaction.execute(
        `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
         VALUES ('integration', ?, 1, CURRENT_TIMESTAMP(3))`,
        [unknownResource],
      );
      return { success: true, resource: unknownResource };
    },
  };
  const commitThenUnknown = {
    async transaction(callback) {
      await db.transaction(callback);
      throw new DatabaseClientError(
        "DATABASE_TRANSACTION_OUTCOME_UNKNOWN",
        "injected after successful commit",
      );
    },
  };
  await assert.rejects(
    executeCommand({ ...unknownOptions, database: commitThenUnknown }),
    (error) => error.code === "COMMAND_OUTCOME_UNKNOWN" &&
      !error.message.includes("injected"),
  );
  const recovered = await executeCommand({ ...unknownOptions, database: db });
  assert.equal(recovered.body.command.replayed, true);
  assert.equal(unknownRuns, 1);

  const failedKey = `mysql-business-rollback-${suffix}`;
  const failedResource = `business-rollback-${suffix}`;
  await assert.rejects(
    executeCommand({
      ...commandOptions,
      payload: { id: 80 },
      request: request(failedKey),
      async run({ transaction }) {
        await transaction.execute(
          `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
           VALUES ('integration', ?, 1, CURRENT_TIMESTAMP(3))`,
          [failedResource],
        );
        await createAuditWriter({ database: transaction })({
          access: { localPreview: false, userId },
          action: "business_rollback_probe",
          module: "platform",
          entityType: "integration",
          entityId: failedResource,
        });
        await enqueueOutbox(transaction, {
          topic: "notification.dispatch",
          aggregateType: "integration",
          aggregateId: failedResource,
          deduplicationKey: `business-rollback:${suffix}`,
          payload: { approvalId: 1, recipientRole: "admin", type: "probe" },
        });
        throw new Error("injected business failure");
      },
    }),
    /injected business failure/u,
  );
  const [businessRollback] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM resource_versions WHERE resource_type = 'integration' AND resource_id = ?) AS versions,
       (SELECT COUNT(*) FROM audit_logs WHERE entity_id = ?) AS audits,
       (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key = ?) AS outboxRows,
       (SELECT COUNT(*) FROM command_idempotency WHERE idempotency_key = ?) AS commands`,
    [failedResource, failedResource, `business-rollback:${suffix}`, failedKey],
  );
  assert.deepEqual(
    [businessRollback.versions, businessRollback.audits,
      businessRollback.outboxRows, businessRollback.commands],
    [0, 0, 0, 0],
  );

  await db.execute(
    `UPDATE writer_fences SET enabled = 0, owner = 'fastify-v1', generation = 2
     WHERE resource = 'notifications.commands'`,
  );
  await assert.rejects(
    executeCommand({
      ...commandOptions,
      request: request(`mysql-fence-${suffix}`),
    }),
    (error) => error.code === "WRITER_FENCE_REJECTED",
  );
  await db.execute(
    `UPDATE writer_fences SET enabled = 1, owner = 'not-fastify-v1', generation = 2
     WHERE resource = 'notifications.commands'`,
  );
  await assert.rejects(
    executeCommand({
      ...commandOptions,
      request: request(`mysql-fence-identity-${suffix}`),
    }),
    (error) => error.code === "WRITER_FENCE_REJECTED",
  );
  await db.execute(
    `UPDATE writer_fences SET enabled = 1, owner = 'fastify-v1', generation = 2
     WHERE resource = 'notifications.commands'`,
  );

  const lockedResource = `lock-${suffix}`;
  await db.execute(
    `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES ('integration', ?, 1, CURRENT_TIMESTAMP(3))`,
    [lockedResource],
  );
  await Promise.all(Array.from({ length: 8 }, () => db.transaction(async (transaction) => {
    const [row] = await transaction.query(
      `SELECT version FROM resource_versions
       WHERE resource_type = 'integration' AND resource_id = ? FOR UPDATE`,
      [lockedResource],
    );
    await transaction.execute(
      `UPDATE resource_versions SET version = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE resource_type = 'integration' AND resource_id = ? AND version = ?`,
      [row.version + 1, lockedResource, row.version],
    );
  })));
  const [locked] = await db.query(
    `SELECT version FROM resource_versions
     WHERE resource_type = 'integration' AND resource_id = ?`,
    [lockedResource],
  );
  assert.equal(locked.version, 9);

  const paymentLockResource = `payment-lock-${suffix}`;
  await db.execute(
    `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES ('payment_request_lock', ?, 100, CURRENT_TIMESTAMP(3))`,
    [paymentLockResource],
  );
  const paymentClaims = await Promise.all(Array.from({ length: 2 }, () =>
    db.transaction(async (transaction) => {
      const [row] = await transaction.query(
        `SELECT version AS remainingMinor FROM resource_versions
         WHERE resource_type = 'payment_request_lock' AND resource_id = ? FOR UPDATE`,
        [paymentLockResource],
      );
      if (row.remainingMinor < 70) return false;
      await delay(100);
      await transaction.execute(
        `UPDATE resource_versions SET version = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE resource_type = 'payment_request_lock' AND resource_id = ? AND version = ?`,
        [row.remainingMinor - 70, paymentLockResource, row.remainingMinor],
      );
      return true;
    }),
  ));
  assert.deepEqual(paymentClaims.sort(), [false, true]);
  const [paymentLock] = await db.query(
    `SELECT version AS remainingMinor FROM resource_versions
     WHERE resource_type = 'payment_request_lock' AND resource_id = ?`,
    [paymentLockResource],
  );
  assert.equal(paymentLock.remainingMinor, 30);

  const sessionToken = `scope-a-session-${suffix}`;
  const session = await db.execute(
    `INSERT INTO auth_sessions (
       user_id, token_hash, device_id, expires_at, created_at, last_seen_at
     ) VALUES (?, ?, 'integration', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [userId, sessionToken, new Date(Date.now() + 3_600_000).toISOString()],
  );
  const sessionId = session.insertId;
  assert.ok(sessionId);
  const challengeNo = `HR-${suffix}`;
  const digest = "ab".repeat(32);
  await db.execute(
    `INSERT INTO auth_challenges (
       challenge_no, user_id, purpose, code_hash, device_id, expires_at,
       attempts, verified_at, session_id, action, object_type, object_id,
       object_version, request_digest, created_at, updated_at
     ) VALUES (?, ?, 'high_risk', 'hash', 'approval:9', ?, 0, ?, ?,
               'approve', 'approval', '9', 3, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [challengeNo, userId, new Date(Date.now() + 300_000).toISOString(),
      new Date().toISOString(), sessionId, digest],
  );
  const claim = {
    challengeNo,
    userId,
    sessionId,
    action: "approve",
    objectType: "approval",
    objectId: "9",
    objectVersion: 3,
    requestDigest: digest,
  };
  const claims = await Promise.allSettled([
    db.transaction((transaction) => consumeStepUpClaim(transaction, claim)),
    db.transaction((transaction) => consumeStepUpClaim(transaction, claim)),
  ]);
  assert.equal(claims.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(claims.filter((value) => value.status === "rejected").length, 1);

  const loginChallenge = `OTP-${suffix}`;
  await db.execute(
    `INSERT INTO auth_challenges (
       challenge_no, user_id, purpose, code_hash, device_id, expires_at,
       attempts, created_at, updated_at
     ) VALUES (?, ?, 'login', 'hash', 'integration', ?, 0,
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [loginChallenge, userId, new Date(Date.now() + 300_000).toISOString()],
  );
  const otpClaims = await Promise.all(
    Array.from({ length: 8 }, () => db.execute(
      `UPDATE auth_challenges SET verified_at = CURRENT_TIMESTAMP(3)
       WHERE challenge_no = ? AND purpose = 'login' AND verified_at IS NULL
         AND attempts < 5 AND expires_at > ?`,
      [loginChallenge, new Date().toISOString()],
    )),
  );
  assert.equal(otpClaims.reduce((sum, value) => sum + value.affectedRows, 0), 1);
});
