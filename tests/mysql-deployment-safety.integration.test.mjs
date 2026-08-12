import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

import { releaseManifestJson } from "../scripts/release-manifest.mjs";
import { FROZEN_MYSQL_MIGRATIONS } from "../scripts/mysql-migration-manifest.mjs";

const adminUrl = process.env.MYSQL_ADMIN_TEST_URL?.trim();
const repositoryRoot = new URL("..", import.meta.url);

function databaseUrl(name) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  return value.toString();
}

function run(script, url, extra = {}, args = []) {
  return spawnSync(process.execPath, [script, ...(Array.isArray(args) ? args : [args])], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, ...extra },
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForWorkerReady(port, expectedStatus = 200) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.status === expectedStatus) return response;
    } catch {
      // The child may not have bound its health port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker readiness did not reach HTTP ${expectedStatus}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) {
    child.kill();
    await exited;
  }
}

async function applyMigration(connection, name) {
  const sql = await readFile(new URL(`../drizzle-mysql/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await connection.query(statement);
  }
}

const canonicalMigrations = FROZEN_MYSQL_MIGRATIONS.map(({ name, hash, createdAt }) => [name, hash, createdAt]);
const workerEntry = fileURLToPath(new URL("../apps/worker/dist/server.js", import.meta.url));

async function createDrizzleHistory(connection) {
  await connection.query(`CREATE TABLE __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at BIGINT
  )`);
}

async function insertHistory(connection, index, overrides = {}) {
  const [, hash, createdAt] = canonicalMigrations[index];
  await connection.execute(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    [overrides.hash ?? hash, overrides.createdAt ?? createdAt],
  );
}

test("fresh-baseline and legacy rollback scripts fail closed on real MySQL state", {
  skip: !adminUrl && "set MYSQL_ADMIN_TEST_URL to run deployment safety integration",
  timeout: 60_000,
}, async (t) => {
  const suffix = `${process.pid}_${Date.now()}`;
  const fresh = `r1final_fresh_${suffix}`;
  const dirty = `r1final_dirty_${suffix}`;
  const rollback = `r1final_rollback_${suffix}`;
  const version = `r1final_version_${suffix}`;
  const admin = await mysql.createConnection(adminUrl);
  t.after(async () => {
    for (const name of [fresh, dirty, rollback, version]) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });
  for (const name of [fresh, dirty, rollback, version]) await admin.query(`CREATE DATABASE \`${name}\``);

  const freshResult = run("scripts/check-mysql-migration-history.mjs", databaseUrl(fresh));
  assert.equal(freshResult.status, 0, freshResult.stderr);
  assert.match(freshResult.stdout, /business schema are empty/u);

  const dirtyDb = await mysql.createConnection(databaseUrl(dirty));
  await dirtyDb.query("CREATE TABLE existing_business_row (id INT PRIMARY KEY)");
  await dirtyDb.end();
  const dirtyResult = run("scripts/check-mysql-migration-history.mjs", databaseUrl(dirty));
  assert.notEqual(dirtyResult.status, 0);
  assert.match(dirtyResult.stderr, /refusing fresh baseline/u);

  const rollbackDb = await mysql.createConnection(databaseUrl(rollback));
  await createDrizzleHistory(rollbackDb);
  for (let index = 0; index < canonicalMigrations.length; index += 1) await insertHistory(rollbackDb, index);
  await rollbackDb.query("CREATE TABLE writer_fences (resource VARCHAR(100) PRIMARY KEY, owner VARCHAR(100) NOT NULL, enabled BOOLEAN NOT NULL, generation INT NOT NULL)");
  await rollbackDb.query("CREATE TABLE command_idempotency (id BIGINT PRIMARY KEY AUTO_INCREMENT, command_name VARCHAR(100), status VARCHAR(20))");
  await rollbackDb.query("INSERT INTO writer_fences VALUES ('auth.commands', 'fastify-v1', 1, 2)");
  const manifestEnv = { TARGET_RELEASE_MANIFEST_JSON: await releaseManifestJson() };
  let result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback), manifestEnv);
  assert.equal(result.status, 0, result.stderr);
  await rollbackDb.query("INSERT INTO command_idempotency (command_name,status) VALUES ('files.upload','completed')");
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback), manifestEnv);
  assert.equal(result.status, 0, result.stderr);
  await rollbackDb.query("INSERT INTO command_idempotency (command_name,status) VALUES ('legacy.finance.write','completed')");
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback), manifestEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not recognize generation-2 write facts.*forward-fix/u);
  await rollbackDb.end();

  const versionDb = await mysql.createConnection(databaseUrl(version));
  await versionDb.query("CREATE TABLE versioned_objects (id INT PRIMARY KEY, updated_at DATETIME(3) NOT NULL)");
  await versionDb.query("CREATE TABLE step_up_proofs (challenge_no VARCHAR(64) PRIMARY KEY, object_version BIGINT UNSIGNED NOT NULL)");
  await versionDb.query("INSERT INTO versioned_objects VALUES (1, '2026-08-12 10:15:30.001')");
  const versionSql = "SELECT CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion FROM versioned_objects WHERE id=1";
  await versionDb.query("SET time_zone='+08:00'");
  const [eastRows] = await versionDb.query(versionSql);
  await versionDb.query("SET time_zone='+00:00'");
  const [utcRows] = await versionDb.query(versionSql);
  assert.equal(Number(eastRows[0].objectVersion), Number(utcRows[0].objectVersion));
  const issuedVersion = Number(eastRows[0].objectVersion);
  await versionDb.query("INSERT INTO step_up_proofs VALUES ('same-second-race', ?)", [issuedVersion]);
  await versionDb.query("UPDATE versioned_objects SET updated_at='2026-08-12 10:15:30.002' WHERE id=1");
  const [newRows] = await versionDb.query(versionSql);
  assert.equal(Number(newRows[0].objectVersion), issuedVersion + 1);
  await versionDb.beginTransaction();
  const [locked] = await versionDb.query(`${versionSql} FOR UPDATE`);
  const [proofs] = await versionDb.query("SELECT object_version AS objectVersion FROM step_up_proofs WHERE challenge_no='same-second-race'");
  if (Number(locked[0].objectVersion) === Number(proofs[0].objectVersion)) {
    await versionDb.query("DELETE FROM step_up_proofs WHERE challenge_no='same-second-race'");
  }
  await versionDb.commit();
  const [remainingProofs] = await versionDb.query("SELECT COUNT(*) AS count FROM step_up_proofs WHERE challenge_no='same-second-race'");
  assert.equal(Number(remainingProofs[0].count), 1, "version conflict must not burn the proof");
  await versionDb.end();
});

test("explicit writer activation is transactional, partial, fail-closed, and idempotent", {
  skip: !adminUrl && "set MYSQL_ADMIN_TEST_URL to run writer activation integration",
  timeout: 60_000,
}, async (t) => {
  const name = `writer_activation_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection(adminUrl);
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${name}\``);
  const db = await mysql.createConnection(databaseUrl(name));
  await db.query("CREATE TABLE writer_fences (resource VARCHAR(191) PRIMARY KEY, owner VARCHAR(191) NOT NULL, enabled BOOLEAN NOT NULL, generation INT NOT NULL, updated_at DATETIME(3))");
  await db.query("CREATE TABLE command_idempotency (id BIGINT PRIMARY KEY AUTO_INCREMENT, status VARCHAR(20))");
  await db.query("CREATE TABLE outbox_messages (id BIGINT PRIMARY KEY AUTO_INCREMENT, status VARCHAR(20))");
  await db.query(`INSERT INTO writer_fences VALUES
    ('auth.commands', 'fastify-v1', 0, 2, CURRENT_TIMESTAMP(3)),
    ('users.commands', 'fastify-v1', 0, 2, CURRENT_TIMESTAMP(3)),
    ('files.commands', 'fastify-v1', 0, 2, CURRENT_TIMESTAMP(3))`);

  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const evidencePath = join(tmpdir(), `writer-activation-${process.pid}-${Date.now()}.json`);
  t.after(async () => {
    await db.end();
    await import("node:fs/promises").then(({ rm }) => rm(evidencePath, { force: true }));
  });
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const releaseTag = "integration-release";
  async function evidence(resources, differences = 0) {
    const json = JSON.stringify({
      version: 1,
      releaseContract: "topology-scm.scope-a.schema-0004.writer-generation-2",
      releaseTag,
      writerGeneration: 2,
      wave: "integration-wave",
      resources,
      drain: { pendingCommands: 0, unknownCommands: 0, processingOutbox: 0 },
      reconciliation: { differences, artifactSha256: "a".repeat(64) },
      approval: { approvedBy: "integration-test", reason: "transaction state verification" },
      observability: { checks: ["error-rate"], artifactSha256: "b".repeat(64) },
    });
    await writeFile(evidencePath, json, "utf8");
    return createHash("sha256").update(json, "utf8").digest("hex");
  }
  async function enabled() {
    const [rows] = await db.query("SELECT resource FROM writer_fences WHERE enabled=1 ORDER BY resource");
    return rows.map(({ resource }) => resource);
  }
  async function activate(resources, hash, extra = {}) {
    return run("scripts/set-writer-fences.mjs", databaseUrl(name), {
      RELEASE_TAG: releaseTag,
      WRITER_ACTIVATION_EVIDENCE_SHA256: hash,
      WRITER_ACTIVATION_RESOURCES: resources,
      ...extra,
    }, evidencePath);
  }

  let result = run("scripts/set-writer-fences.mjs", databaseUrl(name), {
    RELEASE_TAG: releaseTag,
    WRITER_ACTIVATION_EVIDENCE_SHA256: "0".repeat(64),
    WRITER_ACTIVATION_RESOURCES: "",
  }, evidencePath);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await enabled(), []);

  let hash = await evidence(["auth.commands", "auth.commands"]);
  result = await activate("auth.commands,auth.commands", hash);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await enabled(), []);

  hash = await evidence(["unknown.commands"]);
  result = await activate("unknown.commands", hash);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await enabled(), []);

  hash = await evidence(["auth.commands"], 1);
  result = await activate("auth.commands", hash);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await enabled(), []);

  hash = await evidence(["auth.commands", "users.commands"]);
  result = await activate("auth.commands,users.commands", hash);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await enabled(), ["auth.commands", "users.commands"]);
  assert.equal(JSON.parse(result.stdout).changedResources, 2);

  result = await activate("auth.commands,users.commands", hash);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await enabled(), ["auth.commands", "users.commands"]);
  assert.equal(JSON.parse(result.stdout).changedResources, 0);

  await db.query("INSERT INTO command_idempotency (status) VALUES ('pending')");
  hash = await evidence(["files.commands"]);
  result = await activate("files.commands", hash);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await enabled(), ["auth.commands", "users.commands"]);
});

test("fresh install is ready while disabled, consumes only after activation, and repeat deploy preserves fences", {
  skip: !adminUrl && "set MYSQL_ADMIN_TEST_URL to run install-only Worker integration",
  timeout: 180_000,
}, async (t) => {
  const name = `install_only_worker_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection(adminUrl);
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${name}\``);
  const url = databaseUrl(name);
  const connection = await mysql.createConnection(url);
  t.after(async () => connection.end());
  const migrationsFolder = new URL("../drizzle-mysql", import.meta.url).pathname
    .replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
  await migrate(drizzle(connection), { migrationsFolder });

  const [freshFences] = await connection.query(
    "SELECT resource, owner, enabled, generation FROM writer_fences WHERE generation=2 ORDER BY resource",
  );
  assert.equal(freshFences.length, 29);
  assert.ok(freshFences.every(({ enabled }) => Number(enabled) === 0));

  let providerPosts = 0;
  const provider = createServer((request, response) => {
    if (request.method === "POST") providerPosts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const port = await reservePort();
  const worker = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      DB_SSL: "disabled",
      HOST: "127.0.0.1",
      PORT: String(port),
      OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: "33".repeat(32) }),
      SMS_WEBHOOK_URL: `${origin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${origin}/health`,
      EMAIL_WEBHOOK_URL: `${origin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${origin}/health`,
      FILE_SCAN_WEBHOOK_URL: `${origin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${origin}/health`,
    },
    stdio: "ignore",
  });
  t.after(() => stopChild(worker));

  await waitForWorkerReady(port, 200);
  const [outbox] = await connection.execute(
    `INSERT INTO outbox_messages (
       topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
       status, available_at, attempts, max_attempts, created_at, updated_at
     ) VALUES ('email.deliver','install_only','1',?, '{}','pending',CURRENT_TIMESTAMP(3),0,3,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [`install-only-${process.pid}-${Date.now()}`],
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  let [rows] = await connection.query("SELECT status, attempts FROM outbox_messages WHERE id=?", [outbox.insertId]);
  assert.deepEqual({ attempts: Number(rows[0].attempts), status: rows[0].status }, { attempts: 0, status: "pending" });
  assert.equal(providerPosts, 0);

  await connection.query("DELETE FROM writer_fences WHERE resource='files.worker'");
  await waitForWorkerReady(port, 503);
  await connection.query("INSERT INTO writer_fences (resource,owner,enabled,generation,updated_at) VALUES ('files.worker','worker-v1',0,2,CURRENT_TIMESTAMP(3))");
  await connection.query("UPDATE writer_fences SET owner='wrong-owner' WHERE resource='files.worker'");
  await waitForWorkerReady(port, 503);
  await connection.query("UPDATE writer_fences SET owner='worker-v1',generation=1 WHERE resource='files.worker'");
  await waitForWorkerReady(port, 503);
  await connection.query("UPDATE writer_fences SET generation=2,enabled=1 WHERE resource='files.worker'");
  await waitForWorkerReady(port, 200);
  await connection.query("UPDATE writer_fences SET enabled=0 WHERE resource='files.worker'");
  await waitForWorkerReady(port, 200);

  await connection.query("UPDATE writer_fences SET enabled=1 WHERE resource='outbox.worker'");
  await waitForWorkerReady(port, 200);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    [rows] = await connection.query("SELECT status, attempts FROM outbox_messages WHERE id=?", [outbox.insertId]);
    if (rows[0].status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(rows[0].status, "completed");
  assert.equal(providerPosts, 1);

  const [beforeRepeatDeploy] = await connection.query(
    "SELECT resource, owner, enabled, generation FROM writer_fences ORDER BY resource",
  );
  let result = run("scripts/check-mysql-migration-history.mjs", url);
  assert.equal(result.status, 0, result.stderr);
  result = run("scripts/check-write-drain.mjs", url);
  assert.equal(result.status, 0, result.stderr);
  await migrate(drizzle(connection), { migrationsFolder });
  const [afterRepeatDeploy] = await connection.query(
    "SELECT resource, owner, enabled, generation FROM writer_fences ORDER BY resource",
  );
  assert.deepEqual(afterRepeatDeploy, beforeRepeatDeploy);
  assert.equal(Number(afterRepeatDeploy.find(({ resource }) => resource === "outbox.worker").enabled), 1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
});

test("0004 upgrades legacy correction pairs before enforcing payment lineage uniqueness", {
  skip: !adminUrl && "set MYSQL_ADMIN_TEST_URL to run migration upgrade integration",
  timeout: 120_000,
}, async (t) => {
  const name = `scopea_upgrade_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection(adminUrl);
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${name}\``);
  const connection = await mysql.createConnection({ uri: databaseUrl(name), multipleStatements: false });
  t.after(async () => connection.end());
  for (const migration of [
    "0000_hot_firestar.sql",
    "0001_thankful_slyde.sql",
    "0002_scope_a_write_platform.sql",
    "0003_scope_a_write_hardening.sql",
  ]) await applyMigration(connection, migration);

  const [factory] = await connection.execute(
    "INSERT INTO factories (name, code, status) VALUES ('Upgrade Factory', ?, 'active')",
    [`upgrade-${process.pid}-${Date.now()}`],
  );
  const [user] = await connection.execute(
    `INSERT INTO users (email, mobile, name, role, factory_id, organization_name, account_status)
     VALUES (?, '13800138000', 'Upgrade User', 'finance', ?, 'Topology', 'active')`,
    [`upgrade-${process.pid}-${Date.now()}@example.com`, factory.insertId],
  );
  const [request] = await connection.execute(
    `INSERT INTO factory_payment_requests (
       request_no, factory_id, actual_shipment_date, planned_payment_date,
       total_amount_minor, status, maintained_by
     ) VALUES (?, ?, '2026-08-01', '2026-08-31', 10000, 'paid', ?)`,
    [`UPGRADE-${process.pid}-${Date.now()}`, factory.insertId, user.insertId],
  );
  const [original] = await connection.execute(
    `INSERT INTO payment_records (
       payment_request_id, amount_minor, paid_at, bank_reference, record_type,
       recorded_by, review_status
     ) VALUES (?, 10000, '2026-08-01', 'ORIGINAL', 'payment', ?, 'not_required')`,
    [request.insertId, user.insertId],
  );
  await connection.execute(
    `INSERT INTO payment_records (
       payment_request_id, amount_minor, paid_at, bank_reference, record_type,
       reverses_payment_record_id, recorded_by, reviewed_by, review_status
     ) VALUES
       (?, -10000, '2026-08-02', 'REVERSAL', 'reversal', ?, ?, ?, 'approved'),
       (?, 9000, '2026-08-02', 'CORRECTION', 'correction', ?, ?, ?, 'approved')`,
    [request.insertId, original.insertId, user.insertId, user.insertId,
     request.insertId, original.insertId, user.insertId, user.insertId],
  );

  await applyMigration(connection, "0004_scope_a_domain_writes.sql");
  const [rows] = await connection.query(
    `SELECT record_type AS recordType, reverses_payment_record_id AS reversesId,
            corrects_payment_record_id AS correctsId
     FROM payment_records WHERE record_type IN ('reversal','correction') ORDER BY id`,
  );
  assert.deepEqual(rows.map((row) => ({
    correctsId: row.correctsId === null ? null : Number(row.correctsId),
    recordType: row.recordType,
    reversesId: row.reversesId === null ? null : Number(row.reversesId),
  })), [
    { correctsId: null, recordType: "reversal", reversesId: original.insertId },
    { correctsId: original.insertId, recordType: "correction", reversesId: null },
  ]);
  await assert.rejects(
    connection.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         corrects_payment_record_id, recorded_by, review_status
       ) VALUES (?, 8000, '2026-08-03', 'DUPLICATE', 'correction', ?, ?, 'approved')`,
      [request.insertId, original.insertId, user.insertId],
    ),
    /Duplicate entry/u,
  );
});

test("canonical MySQL history upgrades, repeats, and rejects divergent lineages", {
  skip: !adminUrl && "set MYSQL_ADMIN_TEST_URL to run migration history integration",
  timeout: 180_000,
}, async (t) => {
  const suffix = `${process.pid}_${Date.now()}`;
  const names = {
    prefix: `migration_prefix_${suffix}`,
    unknown: `migration_unknown_${suffix}`,
    oldGenesis: `migration_old_genesis_${suffix}`,
    timestamp: `migration_timestamp_${suffix}`,
    idGap: `migration_id_gap_${suffix}`,
    extra: `migration_extra_${suffix}`,
  };
  const admin = await mysql.createConnection(adminUrl);
  t.after(async () => {
    for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });
  for (const name of Object.values(names)) await admin.query(`CREATE DATABASE \`${name}\``);

  const prefix = await mysql.createConnection(databaseUrl(names.prefix));
  await createDrizzleHistory(prefix);
  for (let index = 0; index < 2; index += 1) {
    await applyMigration(prefix, canonicalMigrations[index][0]);
    await insertHistory(prefix, index);
  }
  let result = run("scripts/check-mysql-migration-history.mjs", databaseUrl(names.prefix));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2\/5 canonical entries applied/u);
  const db = drizzle(prefix);
  const migrationsFolder = new URL("../drizzle-mysql", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
  await migrate(db, { migrationsFolder });
  const [afterUpgrade] = await prefix.query("SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at");
  assert.deepEqual(afterUpgrade.map((row) => [row.hash, Number(row.createdAt)]), canonicalMigrations.map(([, hash, createdAt]) => [hash, createdAt]));
  await migrate(db, { migrationsFolder });
  const [[afterRepeat]] = await prefix.query("SELECT COUNT(*) AS count FROM __drizzle_migrations");
  assert.equal(Number(afterRepeat.count), canonicalMigrations.length);
  result = run("scripts/check-mysql-migration-history.mjs", databaseUrl(names.prefix));
  assert.equal(result.status, 0, result.stderr);
  await prefix.end();

  const failures = [
    [names.unknown, { hash: "f".repeat(64) }, /Migration history mismatch/u],
    [names.oldGenesis, { hash: "9570b573c500297d7c17b505852858a87756b67c6e491c7830823c30c00ec26f" }, /Migration history mismatch/u],
    [names.timestamp, { createdAt: canonicalMigrations[0][2] + 1 }, /Migration history mismatch/u],
  ];
  for (const [name, overrides, errorPattern] of failures) {
    const connection = await mysql.createConnection(databaseUrl(name));
    await createDrizzleHistory(connection);
    await insertHistory(connection, 0, overrides);
    await connection.end();
    result = run("scripts/check-mysql-migration-history.mjs", databaseUrl(name));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, errorPattern);
  }

  const idGap = await mysql.createConnection(databaseUrl(names.idGap));
  await createDrizzleHistory(idGap);
  await insertHistory(idGap, 0);
  await idGap.query("UPDATE __drizzle_migrations SET id=2 WHERE id=1");
  await idGap.end();
  result = run("scripts/check-mysql-migration-history.mjs", databaseUrl(names.idGap));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected id=1/u);

  const extra = await mysql.createConnection(databaseUrl(names.extra));
  await createDrizzleHistory(extra);
  for (let index = 0; index < canonicalMigrations.length; index += 1) await insertHistory(extra, index);
  await extra.execute(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    ["e".repeat(64), canonicalMigrations.at(-1)[2] + 1],
  );
  await extra.end();
  result = run("scripts/check-mysql-migration-history.mjs", databaseUrl(names.extra));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown future history/u);
});
