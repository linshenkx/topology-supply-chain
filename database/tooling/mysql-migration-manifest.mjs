import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

export const FROZEN_MYSQL_MIGRATIONS = Object.freeze([
  Object.freeze({ createdAt: 1785334745281, hash: "7d881b148166d64865a3062ff36898888eeef9c5f87fb650f9533c27fb576f7c", name: "0000_hot_firestar.sql", snapshotHash: "9b1f864ba5ba723aede472f2b9ff2ff988eafac5c555d9081ccf2874dd2a84eb" }),
  Object.freeze({ createdAt: 1785662406202, hash: "425efc9f6fd7baa04a80bd6bc03a39716201af5916ae9a62c103e098f52e1577", name: "0001_thankful_slyde.sql", snapshotHash: "ab415cd84c7e9224059e3a240146d803f91e577c95929926e443241daf215e02" }),
  Object.freeze({ createdAt: 1786464478157, hash: "8d2878f9b5e2068343db0d12437b2d92a479cbcb23e0dc668d1395ba703a2a64", name: "0002_scope_a_write_platform.sql", snapshotHash: "7e17fac8a50cc7c8aeb3c361e26f61fd013d08514c27c01c06370ddd8fa1d81b" }),
  Object.freeze({ createdAt: 1786512000000, hash: "f7fb8dcf1ff6185cebd866a39836b0c5ef7b56a7e96ccc8fe438aa572b96df41", name: "0003_scope_a_write_hardening.sql", snapshotHash: "7ad77fc9b64e679828e21e07f5fb3a5b2e41ac9794aa19521d5b03722ce06555" }),
  Object.freeze({ createdAt: 1786521600000, hash: "974aefb885e265e082f4f1a6006b2cd77472cf63183ca1746d0fc83885bf9ecd", name: "0004_scope_a_domain_writes.sql", snapshotHash: "b8565a332aa8a6a7735c5ed9c1c39a29618838f4f770ba5ffc163557031da8a7" }),
]);

export const MYSQL_MIGRATION_DIRECTORY = new URL("../migrations/mysql/", import.meta.url);

function orderedEqual(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertMysqlMigrationDeclarations(migrations = FROZEN_MYSQL_MIGRATIONS) {
  if (!Array.isArray(migrations) || migrations.length === 0) throw new Error("Frozen MySQL migration manifest is empty.");
  const names = new Set();
  const hashes = new Set();
  const snapshotHashes = new Set();
  let previousCreatedAt = 0;
  for (const [index, migration] of migrations.entries()) {
    if (!/^\d{4}_.+\.sql$/u.test(migration.name) || Number(migration.name.slice(0, 4)) !== index) {
      throw new Error(`Frozen MySQL migration name is invalid at entry ${index}.`);
    }
    if (!Number.isSafeInteger(migration.createdAt) || migration.createdAt <= previousCreatedAt) {
      throw new Error(`Frozen MySQL migration createdAt is invalid at entry ${index}.`);
    }
    if (!/^[a-f\d]{64}$/u.test(migration.hash) || !/^[a-f\d]{64}$/u.test(migration.snapshotHash)) {
      throw new Error(`Frozen MySQL migration digest is invalid at entry ${index}.`);
    }
    if (names.has(migration.name) || hashes.has(migration.hash) || snapshotHashes.has(migration.snapshotHash)) {
      throw new Error(`Frozen MySQL migration manifest contains a duplicate at entry ${index}.`);
    }
    names.add(migration.name);
    hashes.add(migration.hash);
    snapshotHashes.add(migration.snapshotHash);
    previousCreatedAt = migration.createdAt;
  }
}

export async function assertFrozenMysqlMigrationRepository(
  migrationDirectory = MYSQL_MIGRATION_DIRECTORY,
  migrations = FROZEN_MYSQL_MIGRATIONS,
) {
  assertMysqlMigrationDeclarations(migrations);
  const expectedSql = migrations.map(({ name }) => name);
  const actualSql = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  if (!orderedEqual(actualSql, expectedSql)) {
    throw new Error(`Repository migration set differs from the frozen manifest. Expected: ${expectedSql.join(", ")}. Found: ${actualSql.join(", ")}.`);
  }

  const metaDirectory = new URL("meta/", migrationDirectory);
  const expectedSnapshots = migrations.map((_, index) => `${String(index).padStart(4, "0")}_snapshot.json`);
  const actualSnapshots = (await readdir(metaDirectory)).filter((name) => /^\d{4}_snapshot\.json$/u.test(name)).sort();
  if (!orderedEqual(actualSnapshots, expectedSnapshots)) {
    throw new Error(`Repository snapshot set differs from the frozen manifest. Expected: ${expectedSnapshots.join(", ")}. Found: ${actualSnapshots.join(", ")}.`);
  }

  let journal;
  try {
    journal = JSON.parse(await readFile(new URL("_journal.json", metaDirectory), "utf8"));
  } catch {
    throw new Error("MySQL migration journal is missing or invalid JSON.");
  }
  if (journal.version !== "7" || journal.dialect !== "mysql" ||
      !Array.isArray(journal.entries) || journal.entries.length !== migrations.length) {
    throw new Error("MySQL migration journal header or entry count differs from the frozen manifest.");
  }

  for (const [index, expected] of migrations.entries()) {
    const entry = journal.entries[index];
    const sqlHash = sha256(await readFile(new URL(expected.name, migrationDirectory)));
    const snapshotHash = sha256(await readFile(new URL(expectedSnapshots[index], metaDirectory)));
    if (entry?.idx !== index || entry?.version !== "5" || entry?.breakpoints !== true ||
        `${entry?.tag}.sql` !== expected.name || Number(entry?.when) !== expected.createdAt ||
        sqlHash !== expected.hash || snapshotHash !== expected.snapshotHash) {
      throw new Error(`Repository migration history mismatch at entry ${index} (${expected.name}); SQL, snapshot, journal idx/tag/when/version/breakpoints are immutable.`);
    }
  }
  return migrations;
}
