import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { createDatabaseClient } from "../dist/infrastructure/database.js";
import manifest from "../dist/composition/supply-writes-manifest.js";
import { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "../dist/platform/approvals.js";
import { requireWriterFence } from "../dist/platform/commands.js";
import { enqueueOutbox } from "../dist/platform/outbox.js";
import { FileAuthorizationRegistry } from "../dist/platform/registrations.js";

const databaseUrl = process.env.MYSQL_SUPPLY_TEST_URL?.trim();
const TOKEN = "cd".repeat(32);

function headers(key) {
  return {
    host: "localhost",
    origin: "http://localhost",
    "x-forwarded-proto": "http",
    cookie: `topology_csrf=${TOKEN}`,
    "x-csrf-token": TOKEN,
    "idempotency-key": key,
  };
}

test("real MySQL supply command is atomic, audited, outboxed, replayable, and fenced", {
  skip: !databaseUrl && "set MYSQL_SUPPLY_TEST_URL to run supply MySQL integration",
  timeout: 60_000,
}, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const db = createDatabaseClient({ env: {
    DATABASE_URL: databaseUrl,
    DB_SSL: "disabled",
    DB_POOL_SIZE: "10",
    DB_QUERY_TIMEOUT_MS: "30000",
    DB_TRANSACTION_TIMEOUT_MS: "30000",
  } });
  const user = await db.execute(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, '13800138000', 'R2 Integration', 'supply_chain', 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`r2-${suffix}@example.com`],
  );
  assert.ok(user.insertId);
  const userId = user.insertId;
  const effectiveFrom = "2099-08-12";
  const commandKey = `r2-mysql-command-${suffix}`;
  let weightId;
  const app = await buildApp({ logger: false });
  const access = { sessionId: 1, userId, email: `r2-${suffix}@example.com`, name: "R2 Integration", roles: ["supply_chain"], factoryId: null, supplierId: null, organizationName: "Topology", localPreview: false };
  await manifest.register({
    app,
    database: db,
    unitOfWork: (run) => db.transaction(run),
    executeCommand: async () => { throw new Error("Supply must not call platform executeCommand"); },
    requireWriterFence,
    authenticate: async () => access,
    authorize: () => false,
    audit: async () => {},
    enqueueOutbox,
    approvalPolicy: new ApprovalPolicyRegistry(),
    approvalEffects: new ApprovalEffectRegistry(),
    fileAuthorizations: new FileAuthorizationRegistry(),
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    if (weightId !== undefined) await db.execute("DELETE FROM outbox_messages WHERE aggregate_type = 'performance_weights' AND aggregate_id = ?", [String(weightId)]).catch(() => {});
    await db.execute("DELETE FROM supplier_performance_weight_versions WHERE tier = 1 AND effective_from = ?", [effectiveFrom]).catch(() => {});
    await db.execute("DELETE FROM command_idempotency WHERE actor_scope = ?", [`user:${userId}`]).catch(() => {});
    await db.execute("DELETE FROM audit_logs WHERE actor_user_id = ?", [userId]).catch(() => {});
    await db.execute("DELETE FROM users WHERE id = ?", [userId]).catch(() => {});
    await db.execute("UPDATE writer_fences SET enabled = 0 WHERE resource = 'r2.supplier-performance.write'").catch(() => {});
    await db.close();
  });

  await db.execute(
    `UPDATE writer_fences SET owner = 'fastify-v1', generation = 2, enabled = 1
     WHERE resource = 'r2.supplier-performance.write'`,
  );
  const payload = {
    action: "weights", tier: 1, effectiveFrom,
    delivery: 25, quality: 20, exception: 15, preparation: 10, satisfaction: 15, sampling: 15,
  };
  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/api/v1/supplier-performance", headers: headers(commandKey), payload }),
    app.inject({ method: "POST", url: "/api/v1/supplier-performance", headers: headers(commandKey), payload }),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(responses.map((response) => response.json().command.replayed).sort(), [false, true]);
  weightId = responses[0].json().result.weightId;
  const [counts] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM supplier_performance_weight_versions WHERE tier = 1 AND effective_from = ?) AS domainRows,
       (SELECT COUNT(*) FROM command_idempotency WHERE command_name = 'supplier-performance.write' AND actor_scope = ? AND idempotency_key = ?) AS commands,
       (SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = ? AND action = 'create_weights') AS audits,
       (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type = 'performance_weights' AND aggregate_id = ?) AS outboxRows`,
    [effectiveFrom, `user:${userId}`, commandKey, userId, String(weightId)],
  );
  assert.deepEqual([counts.domainRows, counts.commands, counts.audits, counts.outboxRows], [1, 1, 1, 1]);

  const reused = await app.inject({
    method: "POST", url: "/api/v1/supplier-performance", headers: headers(commandKey),
    payload: { ...payload, delivery: 24, quality: 21 },
  });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().code, "IDEMPOTENCY_KEY_REUSED");

  await db.execute("UPDATE writer_fences SET enabled = 0 WHERE resource = 'r2.supplier-performance.write'");
  const fenced = await app.inject({
    method: "POST", url: "/api/v1/supplier-performance", headers: headers(`r2-mysql-fence-${suffix}`), payload,
  });
  assert.equal(fenced.statusCode, 503);
  assert.equal(fenced.json().code, "WRITER_FENCE_REJECTED");
});
