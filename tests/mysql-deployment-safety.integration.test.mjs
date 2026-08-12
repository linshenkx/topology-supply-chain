import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

const adminUrl = process.env.MYSQL_ADMIN_TEST_URL?.trim();
const repositoryRoot = new URL("..", import.meta.url);

function databaseUrl(name) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  return value.toString();
}

function run(script, url, extra = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, ...extra },
  });
}

async function applyMigration(connection, name) {
  const sql = await readFile(new URL(`../drizzle-mysql/${name}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    await connection.query(statement);
  }
}

const canonicalMigrations = [
  ["0000_hot_firestar.sql", "7d881b148166d64865a3062ff36898888eeef9c5f87fb650f9533c27fb576f7c", 1785334745281],
  ["0001_thankful_slyde.sql", "425efc9f6fd7baa04a80bd6bc03a39716201af5916ae9a62c103e098f52e1577", 1785662406202],
  ["0002_scope_a_write_platform.sql", "8d2878f9b5e2068343db0d12437b2d92a479cbcb23e0dc668d1395ba703a2a64", 1786464478157],
  ["0003_scope_a_write_hardening.sql", "f7fb8dcf1ff6185cebd866a39836b0c5ef7b56a7e96ccc8fe438aa572b96df41", 1786512000000],
  ["0004_scope_a_domain_writes.sql", "974aefb885e265e082f4f1a6006b2cd77472cf63183ca1746d0fc83885bf9ecd", 1786521600000],
];

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
  await rollbackDb.query("CREATE TABLE writer_fences (resource VARCHAR(100) PRIMARY KEY, enabled BOOLEAN NOT NULL, generation INT NOT NULL)");
  await rollbackDb.query("CREATE TABLE command_idempotency (id BIGINT PRIMARY KEY AUTO_INCREMENT, command_name VARCHAR(100), status VARCHAR(20))");
  await rollbackDb.query("CREATE TABLE outbox_messages (id BIGINT PRIMARY KEY AUTO_INCREMENT, status VARCHAR(20))");
  await rollbackDb.query("INSERT INTO writer_fences VALUES ('auth.commands', 1, 2)");
  let result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still enabled/u);
  await rollbackDb.query("UPDATE writer_fences SET enabled=0");
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback));
  assert.equal(result.status, 0, result.stderr);
  await rollbackDb.query("INSERT INTO command_idempotency (command_name,status) VALUES ('files.upload','completed')");
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forward-fix/u);
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback), { LEGACY_ROLLBACK_RECONCILED_GENERATION: "2" });
  assert.equal(result.status, 0, result.stderr);
  await rollbackDb.query("UPDATE command_idempotency SET status='unknown'");
  result = run("scripts/check-legacy-rollback-safety.mjs", databaseUrl(rollback), { LEGACY_ROLLBACK_RECONCILED_GENERATION: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /in-flight writes remain/u);
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
