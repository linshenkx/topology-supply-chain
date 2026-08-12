import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

import mysql from "mysql2/promise";

const databaseUrl = process.env.MYSQL_WRITE_TEST_URL?.trim();
const workerEntry = fileURLToPath(new URL("../dist/server.js", import.meta.url));

async function waitForCompleted(pool, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [rows] = await pool.query(
      "SELECT status FROM outbox_messages WHERE id = ?",
      [id],
    );
    if (rows[0]?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("worker did not complete notification dispatch");
}

async function waitForStatus(pool, id, status) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [rows] = await pool.query("SELECT status, last_error_code AS errorCode FROM outbox_messages WHERE id = ?", [id]);
    if (rows[0]?.status === status) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`worker did not reach ${status}`);
}

async function runUntilCompleted(pool, id, port, providerOrigin) {
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DB_SSL: "disabled",
      HOST: "127.0.0.1",
      PORT: String(port),
      OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: "33".repeat(32) }),
      SMS_WEBHOOK_URL: `${providerOrigin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${providerOrigin}/health`,
      EMAIL_WEBHOOK_URL: `${providerOrigin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${providerOrigin}/health`,
      FILE_SCAN_WEBHOOK_URL: `${providerOrigin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${providerOrigin}/health`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForCompleted(pool, id);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
}

test("notification fan-out is idempotent when a completed transaction is redelivered", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Worker replay integration",
  timeout: 60_000,
}, async (t) => {
  const provider = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4 });
  t.after(async () => pool.end());
  await pool.execute(
    `UPDATE writer_fences SET owner = 'worker-v1', enabled = 1, generation = 2
     WHERE resource IN ('outbox.worker','reminders.worker','files.worker')`,
  );
  const suffix = `${process.pid}-${Date.now()}`;
  const [userResult] = await pool.execute(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status,
       created_at, updated_at
     ) VALUES (?, ?, 'Worker Replay Admin', 'admin', 'Topology', 'active',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`worker-replay-${suffix}@example.com`, `139${String(Date.now()).slice(-8)}`],
  );
  const userId = userResult.insertId;
  const approvalId = 800_000_000 + (Date.now() % 100_000_000);
  const deduplicationKey = `worker-replay-${suffix}`;
  const [outboxResult] = await pool.execute(
    `INSERT INTO outbox_messages (
       topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
       status, available_at, attempts, max_attempts, created_at, updated_at
     ) VALUES ('notification.dispatch', 'approval_request', ?, ?, ?, 'pending',
               ?, 0, 8, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [String(approvalId), deduplicationKey,
      JSON.stringify({ approvalId, recipientRole: "admin", type: "user_role_change" }),
      new Date().toISOString()],
  );
  const outboxId = outboxResult.insertId;
  assert.ok(userId > 0 && outboxId > 0);

  const port = 34_000 + (process.pid % 1_000);
  await runUntilCompleted(pool, outboxId, port, providerOrigin);
  const [terminalSms] = await pool.query(
    `SELECT payload_json AS payloadJson FROM outbox_messages
     WHERE topic = 'sms.deliver' AND status IN ('completed','dead')`,
  );
  for (const row of terminalSms) assert.equal(row.payloadJson, '{"redacted":true}');
  await pool.execute(
    `UPDATE outbox_messages
     SET status = 'pending', attempts = 0, completed_at = NULL,
         locked_by = NULL, locked_at = NULL, available_at = ?
     WHERE id = ?`,
    [new Date().toISOString(), outboxId],
  );
  await runUntilCompleted(pool, outboxId, port, providerOrigin);

  const [messages] = await pool.query(
    `SELECT id, channel
     FROM notification_messages
     WHERE recipient_user_id = ? AND entity_type = 'approval_request' AND entity_id = ?
     ORDER BY channel`,
    [userId, approvalId],
  );
  assert.deepEqual(messages.map((row) => row.channel), ["email", "in_app"]);
  const email = messages.find((row) => row.channel === "email");
  const [derived] = await pool.query(
    `SELECT COUNT(*) AS count FROM outbox_messages
     WHERE topic = 'email.deliver' AND aggregate_type = 'notification'
       AND aggregate_id = ?`,
    [String(email.id)],
  );
  assert.equal(Number(derived[0].count), 1);
});

test("generic domain events preserve entity and recipient semantics without approval fields", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Worker domain-event integration",
  timeout: 60_000,
}, async (t) => {
  const provider = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4 });
  t.after(async () => pool.end());
  await pool.execute(
    `UPDATE writer_fences SET owner = 'worker-v1', enabled = 1, generation = 2
     WHERE resource IN ('outbox.worker','reminders.worker','files.worker')`,
  );
  const suffix = `${process.pid}-${Date.now()}`;
  const [userResult] = await pool.execute(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status,
       created_at, updated_at
     ) VALUES (?, ?, 'Domain Event Supply Chain', 'supply_chain', 'Topology', 'active',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`domain-event-${suffix}@example.com`, `138${String(Date.now()).slice(-8)}`],
  );
  const entityId = 700_000_000 + (Date.now() % 100_000_000);
  const payload = {
    schemaVersion: 1,
    entityType: "import_batch",
    entityId: String(entityId),
    eventType: "ImportStaged",
    recipient: { kind: "role", role: "supply_chain" },
    data: { rowCount: 3, type: "purchase_plan" },
  };
  assert.equal("approvalId" in payload, false);
  const [outboxResult] = await pool.execute(
    `INSERT INTO outbox_messages (
       topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
       status, available_at, attempts, max_attempts, created_at, updated_at
     ) VALUES ('domain.event', 'import_batch', ?, ?, ?, 'pending',
               ?, 0, 8, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [String(entityId), `domain-event-${suffix}`, JSON.stringify(payload), new Date().toISOString()],
  );
  await runUntilCompleted(pool, outboxResult.insertId, 37_000 + (process.pid % 1_000), providerOrigin);
  const [messages] = await pool.query(
    `SELECT channel, type, entity_type AS entityType, entity_id AS entityId, message
     FROM notification_messages
     WHERE recipient_user_id = ? AND entity_type = 'import_batch' AND entity_id = ?`,
    [userResult.insertId, entityId],
  );
  assert.deepEqual(messages.map((row) => ({
    channel: row.channel,
    entityId: Number(row.entityId),
    entityType: row.entityType,
    message: JSON.parse(row.message),
    type: row.type,
  })), [{
    channel: "in_app",
    entityId,
    entityType: "import_batch",
    message: { rowCount: 3, type: "purchase_plan" },
    type: "ImportStaged",
  }]);

  const [factory] = await pool.execute(
    "INSERT INTO factories (name, code, status) VALUES ('Domain Event Factory', ?, 'active')",
    [`domain-event-factory-${suffix}`],
  );
  await pool.execute("UPDATE users SET factory_id = ? WHERE id = ?", [factory.insertId, userResult.insertId]);
  await pool.execute(
    `INSERT INTO user_roles (
       user_id, role_code, effective_from, status, requested_by, created_at, updated_at
     ) VALUES (?, 'factory', '2026-08-12', 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [userResult.insertId, userResult.insertId],
  );
  const [supplier] = await pool.execute(
    "INSERT INTO suppliers (code, name, status) VALUES (?, 'Domain Event Supplier', 'active')",
    [`domain-event-supplier-${suffix}`],
  );
  const [supplierSku] = await pool.execute(
    `INSERT INTO supplier_skus (
       factory_id, supplier_id, sku, effective_from, status, requested_by
     ) VALUES (?, ?, ?, '2026-08-12', 'active', ?)`,
    [factory.insertId, supplier.insertId, `DOMAIN-EVENT-${suffix}`, userResult.insertId],
  );
  const boundPayload = {
    schemaVersion: 1,
    entityType: "supplier_sku",
    entityId: String(supplierSku.insertId),
    eventType: "SupplierSkuActivated",
    recipient: {
      kind: "entity_binding",
      role: "factory",
      entityType: "supplier_sku",
      entityId: String(supplierSku.insertId),
    },
    data: { status: "active" },
  };
  const [boundOutbox] = await pool.execute(
    `INSERT INTO outbox_messages (
       topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
       status, available_at, attempts, max_attempts, created_at, updated_at
     ) VALUES ('domain.event', 'supplier_sku', ?, ?, ?, 'pending',
               ?, 0, 8, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [String(supplierSku.insertId), `domain-event-binding-${suffix}`,
      JSON.stringify(boundPayload), new Date().toISOString()],
  );
  await runUntilCompleted(pool, boundOutbox.insertId, 38_000 + (process.pid % 1_000), providerOrigin);
  const [boundMessages] = await pool.query(
    `SELECT type, entity_type AS entityType, entity_id AS entityId
     FROM notification_messages
     WHERE recipient_user_id = ? AND entity_type = 'supplier_sku' AND entity_id = ?`,
    [userResult.insertId, supplierSku.insertId],
  );
  assert.deepEqual(boundMessages.map((row) => ({
    entityId: Number(row.entityId), entityType: row.entityType, type: row.type,
  })), [{ entityId: supplierSku.insertId, entityType: "supplier_sku", type: "SupplierSkuActivated" }]);
});

test("an expired final-attempt lease is deterministically dead-lettered", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Worker lease integration",
  timeout: 60_000,
}, async (t) => {
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4 });
  t.after(async () => pool.end());
  await pool.execute(`UPDATE writer_fences SET owner='worker-v1', enabled=1, generation=2 WHERE resource IN ('outbox.worker','reminders.worker','files.worker')`);
  const [inserted] = await pool.execute(
    `INSERT INTO outbox_messages (topic, aggregate_type, aggregate_id, deduplication_key,
       payload_json, status, available_at, attempts, max_attempts, locked_by, locked_at, created_at, updated_at)
     VALUES ('email.deliver','lease_test','1',?, '{}','processing',?,3,3,'crashed-worker',?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [`lease-exhausted-${process.pid}-${Date.now()}`, new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() - 600_000).toISOString()],
  );
  const provider = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, [workerEntry], { env: {
    ...process.env, DATABASE_URL: databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(35_000 + (process.pid % 1_000)),
    OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: "33".repeat(32) }),
    SMS_WEBHOOK_URL: `${origin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${origin}/health`,
    EMAIL_WEBHOOK_URL: `${origin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${origin}/health`,
    FILE_SCAN_WEBHOOK_URL: `${origin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${origin}/health`,
  }, stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));
  const row = await waitForStatus(pool, inserted.insertId, "dead");
  assert.equal(row.errorCode, "LEASE_EXHAUSTED");
});

test("a disabled generation fence pauses delivery without consuming an attempt", {
  skip: !databaseUrl && "set MYSQL_WRITE_TEST_URL to run Worker fence integration",
  timeout: 60_000,
}, async (t) => {
  let emailPosts = 0;
  const provider = createServer((request, response) => {
    if (request.url === "/email" && request.method === "POST") emailPosts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4 });
  t.after(async () => pool.end());
  await pool.execute(`UPDATE writer_fences SET owner='worker-v1', generation=2, enabled=1 WHERE resource IN ('reminders.worker','files.worker')`);
  await pool.execute(`UPDATE writer_fences SET owner='worker-v1', generation=2, enabled=0 WHERE resource='outbox.worker'`);
  const [inserted] = await pool.execute(
    `INSERT INTO outbox_messages (topic, aggregate_type, aggregate_id, deduplication_key,
       payload_json, status, available_at, attempts, max_attempts, created_at, updated_at)
     VALUES ('email.deliver','fence_test','1',?, '{}','pending',CURRENT_TIMESTAMP(3),0,3,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [`fence-pause-${process.pid}-${Date.now()}`],
  );
  const child = spawn(process.execPath, [workerEntry], { env: {
    ...process.env, DATABASE_URL: databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(36_000 + (process.pid % 1_000)),
    OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: "33".repeat(32) }),
    SMS_WEBHOOK_URL: `${origin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${origin}/health`,
    EMAIL_WEBHOOK_URL: `${origin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${origin}/health`,
    FILE_SCAN_WEBHOOK_URL: `${origin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${origin}/health`,
  }, stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const [paused] = await pool.query("SELECT status, attempts FROM outbox_messages WHERE id = ?", [inserted.insertId]);
  assert.equal(paused[0].status, "pending");
  assert.equal(Number(paused[0].attempts), 0);
  assert.equal(emailPosts, 0);
  await pool.execute(`UPDATE writer_fences SET enabled=1 WHERE resource='outbox.worker' AND owner='worker-v1' AND generation=2`);
  await waitForCompleted(pool, inserted.insertId);
  assert.equal(emailPosts, 1);
});
