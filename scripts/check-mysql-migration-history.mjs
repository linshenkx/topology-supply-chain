import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import mysql from "mysql2/promise";

// This manifest is the immutable MySQL genesis contract. Change it only by
// appending a newly reviewed migration; never replace an existing entry.
const canonicalHistory = [
  { name: "0000_hot_firestar.sql", createdAt: 1785334745281, hash: "7d881b148166d64865a3062ff36898888eeef9c5f87fb650f9533c27fb576f7c", snapshotHash: "9b1f864ba5ba723aede472f2b9ff2ff988eafac5c555d9081ccf2874dd2a84eb" },
  { name: "0001_thankful_slyde.sql", createdAt: 1785662406202, hash: "425efc9f6fd7baa04a80bd6bc03a39716201af5916ae9a62c103e098f52e1577", snapshotHash: "ab415cd84c7e9224059e3a240146d803f91e577c95929926e443241daf215e02" },
  { name: "0002_scope_a_write_platform.sql", createdAt: 1786464478157, hash: "8d2878f9b5e2068343db0d12437b2d92a479cbcb23e0dc668d1395ba703a2a64", snapshotHash: "7e17fac8a50cc7c8aeb3c361e26f61fd013d08514c27c01c06370ddd8fa1d81b" },
  { name: "0003_scope_a_write_hardening.sql", createdAt: 1786512000000, hash: "f7fb8dcf1ff6185cebd866a39836b0c5ef7b56a7e96ccc8fe438aa572b96df41", snapshotHash: "7ad77fc9b64e679828e21e07f5fb3a5b2e41ac9794aa19521d5b03722ce06555" },
  { name: "0004_scope_a_domain_writes.sql", createdAt: 1786521600000, hash: "974aefb885e265e082f4f1a6006b2cd77472cf63183ca1746d0fc83885bf9ecd", snapshotHash: "b8565a332aa8a6a7735c5ed9c1c39a29618838f4f770ba5ffc163557031da8a7" },
];

const migrationDirectory = new URL("../drizzle-mysql/", import.meta.url);

async function assertCanonicalRepositoryHistory() {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const expectedFiles = canonicalHistory.map(({ name }) => name);
  if (files.length !== expectedFiles.length || files.some((name, index) => name !== expectedFiles[index])) {
    throw new Error(`Repository migration set differs from the frozen manifest. Expected: ${expectedFiles.join(", ")}. Found: ${files.join(", ")}. Append a reviewed manifest entry; never rewrite history.`);
  }

  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationDirectory), "utf8"));
  const snapshotFiles = (await readdir(new URL("meta/", migrationDirectory)))
    .filter((name) => /^\d{4}_snapshot\.json$/u.test(name))
    .sort();
  const expectedSnapshots = canonicalHistory.map((_, index) => `${String(index).padStart(4, "0")}_snapshot.json`);
  if (snapshotFiles.length !== expectedSnapshots.length || snapshotFiles.some((name, index) => name !== expectedSnapshots[index])) {
    throw new Error(`Repository snapshot set differs from the frozen manifest. Expected: ${expectedSnapshots.join(", ")}. Found: ${snapshotFiles.join(", ")}.`);
  }
  if (journal.version !== "7" || journal.dialect !== "mysql" || journal.entries?.length !== canonicalHistory.length) {
    throw new Error("MySQL migration journal differs from the frozen manifest; refusing database access.");
  }

  for (const [index, expected] of canonicalHistory.entries()) {
    const entry = journal.entries[index];
    const hash = createHash("sha256")
      .update(await readFile(new URL(expected.name, migrationDirectory)))
      .digest("hex");
    const snapshotHash = createHash("sha256")
      .update(await readFile(new URL(`meta/${String(index).padStart(4, "0")}_snapshot.json`, migrationDirectory)))
      .digest("hex");
    if (entry?.idx !== index || entry.version !== "5" || entry.breakpoints !== true || `${entry.tag}.sql` !== expected.name || Number(entry.when) !== expected.createdAt || hash !== expected.hash || snapshotHash !== expected.snapshotHash) {
      throw new Error(`Repository migration history mismatch at entry ${index} (${expected.name}); refusing database access. Historical migrations and journal timestamps are immutable.`);
    }
  }
}

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
await assertCanonicalRepositoryHistory();

const connection = await mysql.createConnection(url);
async function assertFreshSchema() {
  const [objects] = await connection.query(
    `SELECT 'table_or_view' AS kind, table_name AS name
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations'
     UNION ALL
     SELECT 'trigger' AS kind, trigger_name AS name
       FROM information_schema.triggers WHERE trigger_schema = DATABASE()
     UNION ALL
     SELECT 'routine' AS kind, routine_name AS name
       FROM information_schema.routines WHERE routine_schema = DATABASE()
     UNION ALL
     SELECT 'event' AS kind, event_name AS name
       FROM information_schema.events WHERE event_schema = DATABASE()`,
  );
  if (objects.length !== 0) {
    throw new Error(`Migration history is empty but schema contains ${objects[0].kind} ${objects[0].name}; refusing fresh baseline.`);
  }
  console.log("Migration history and business schema are empty; fresh baseline is allowed.");
}

try {
  let rows;
  try {
    [rows] = await connection.query("SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at ASC, id ASC");
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") rows = [];
    else throw error;
  }

  if (rows.length === 0) await assertFreshSchema();
  if (rows.length > canonicalHistory.length) {
    throw new Error(`Database has ${rows.length} migration entries but the frozen manifest has ${canonicalHistory.length}; refusing unknown future history.`);
  }
  for (const [index, row] of rows.entries()) {
    const expected = canonicalHistory[index];
    if (Number(row.id) !== index + 1 || row.hash !== expected.hash || Number(row.createdAt) !== expected.createdAt) {
      throw new Error(`Migration history mismatch at entry ${index} (${expected.name}). Observed id=${row.id}, hash=${row.hash}, created_at=${row.createdAt}; expected id=${index + 1}, hash=${expected.hash}, created_at=${expected.createdAt}. Stop for forensic reconciliation; never rewrite __drizzle_migrations.`);
    }
  }
  console.log(`Migration history preflight passed (${rows.length}/${canonicalHistory.length} canonical entries applied).`);
} finally {
  await connection.end();
}
