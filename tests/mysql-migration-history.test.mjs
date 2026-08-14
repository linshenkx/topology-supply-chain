import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  assertFrozenMysqlMigrationRepository,
  assertMysqlMigrationDeclarations,
  FROZEN_MYSQL_MIGRATIONS,
} from "../database/tooling/mysql-migration-manifest.mjs";
import { releaseManifestJson } from "../tooling/release/release-manifest.mjs";

const repositoryMigrations = new URL("../database/migrations/mysql/", import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mysql-migration-manifest-"));
  const directory = join(root, "database/migrations/mysql");
  await cp(repositoryMigrations, directory, { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  return { directory, url: pathToFileURL(`${directory}/`) };
}

async function mutateJson(path, mutate) {
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, JSON.stringify(value), "utf8");
}

test("one frozen manifest validates SQL, snapshots, and the full journal before callers proceed", async () => {
  assert.equal((await assertFrozenMysqlMigrationRepository()).length, 6);
  assert.deepEqual(FROZEN_MYSQL_MIGRATIONS.map(({ name }) => name), [
    "0000_hot_firestar.sql",
    "0001_thankful_slyde.sql",
    "0002_scope_a_write_platform.sql",
    "0003_scope_a_write_hardening.sql",
    "0004_scope_a_domain_writes.sql",
    "0005_tricky_kabuki.sql",
  ]);
  for (const migration of FROZEN_MYSQL_MIGRATIONS) {
    assert.match(migration.hash, /^[a-f\d]{64}$/u);
    assert.match(migration.snapshotHash, /^[a-f\d]{64}$/u);
    assert.ok(Number.isSafeInteger(migration.createdAt));
  }
  const preflight = await readFile(new URL("../tooling/release/check-mysql-migration-history.mjs", import.meta.url), "utf8");
  const release = await readFile(new URL("../tooling/release/release-manifest.mjs", import.meta.url), "utf8");
  assert.match(preflight, /await assertFrozenMysqlMigrationRepository\(\);[\s\S]*mysql\.createConnection/u);
  assert.match(release, /async function releaseManifestJson\(migrationDirectory\)[\s\S]*await assertFrozenMysqlMigrationRepository\(migrationDirectory\)/u);
  assert.doesNotMatch(preflight, /const canonicalHistory/u);
  assert.doesNotMatch(release, /0000_hot_firestar/u);
  assert.doesNotMatch(preflight, /UPDATE\s+__drizzle_migrations/iu);
});

test("missing and extra migration or snapshot entries are rejected", async (t) => {
  for (const [name, mutate, pattern] of [
    ["missing SQL", async ({ directory }) => rm(join(directory, FROZEN_MYSQL_MIGRATIONS[4].name)), /migration set differs/u],
    ["extra SQL", async ({ directory }) => writeFile(join(directory, "0006_unreviewed.sql"), "SELECT 1;", "utf8"), /migration set differs/u],
    ["missing snapshot", async ({ directory }) => rm(join(directory, "meta", "0004_snapshot.json")), /snapshot set differs/u],
    ["extra snapshot", async ({ directory }) => writeFile(join(directory, "meta", "0006_snapshot.json"), "{}", "utf8"), /snapshot set differs/u],
  ]) {
    await t.test(name, async (child) => {
      const copy = await fixture(child);
      await mutate(copy);
      await assert.rejects(assertFrozenMysqlMigrationRepository(copy.url), pattern);
    });
  }
});

test("frozen declaration omissions, timestamps, digests, names, and duplicates are rejected", () => {
  const clone = () => FROZEN_MYSQL_MIGRATIONS.map((entry) => ({ ...entry }));
  for (const [name, mutate, pattern] of [
    ["empty", (items) => items.splice(0), /manifest is empty/u],
    ["missing middle entry", (items) => items.splice(2, 1), /name is invalid/u],
    ["timestamp", (items) => { items[1].createdAt = items[0].createdAt; }, /createdAt is invalid/u],
    ["SQL digest", (items) => { items[0].hash = "bad"; }, /digest is invalid/u],
    ["snapshot digest", (items) => { items[0].snapshotHash = "bad"; }, /digest is invalid/u],
    ["name", (items) => { items[0].name = "0001_wrong.sql"; }, /name is invalid/u],
    ["duplicate", (items) => { items[1].hash = items[0].hash; }, /duplicate/u],
  ]) {
    const items = clone();
    mutate(items);
    assert.throws(() => assertMysqlMigrationDeclarations(items), pattern, name);
  }
});

test("SQL, snapshot, and every journal contract field drift are rejected", async (t) => {
  const cases = [
    ["SQL bytes", async ({ directory }) => writeFile(join(directory, FROZEN_MYSQL_MIGRATIONS[0].name), "SELECT 1;", "utf8")],
    ["snapshot bytes", async ({ directory }) => writeFile(join(directory, "meta", "0000_snapshot.json"), "{}", "utf8")],
    ["journal idx", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries[0].idx = 1; })],
    ["journal tag", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries[0].tag = "0000_other"; })],
    ["journal when", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries[0].when += 1; })],
    ["journal entry version", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries[0].version = "4"; })],
    ["journal breakpoints", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries[0].breakpoints = false; })],
    ["journal header version", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.version = "6"; })],
    ["journal dialect", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.dialect = "sqlite"; })],
    ["journal missing entry", ({ directory }) => mutateJson(join(directory, "meta", "_journal.json"), (journal) => { journal.entries.pop(); })],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (child) => {
      const copy = await fixture(child);
      await mutate(copy);
      await assert.rejects(assertFrozenMysqlMigrationRepository(copy.url), /migration history mismatch|journal header or entry count/u);
    });
  }
});

test("release manifest serialization refuses repository drift through the shared validator", async (t) => {
  const copy = await fixture(t);
  await writeFile(join(copy.directory, FROZEN_MYSQL_MIGRATIONS[0].name), "SELECT 1;", "utf8");
  await assert.rejects(releaseManifestJson(copy.url), /migration history mismatch/u);
});
