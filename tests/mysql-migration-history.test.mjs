import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const canonical = [
  ["0000_hot_firestar.sql", 1785334745281, "7d881b148166d64865a3062ff36898888eeef9c5f87fb650f9533c27fb576f7c"],
  ["0001_thankful_slyde.sql", 1785662406202, "425efc9f6fd7baa04a80bd6bc03a39716201af5916ae9a62c103e098f52e1577"],
  ["0002_scope_a_write_platform.sql", 1786464478157, "8d2878f9b5e2068343db0d12437b2d92a479cbcb23e0dc668d1395ba703a2a64"],
  ["0003_scope_a_write_hardening.sql", 1786512000000, "f7fb8dcf1ff6185cebd866a39836b0c5ef7b56a7e96ccc8fe438aa572b96df41"],
  ["0004_scope_a_domain_writes.sql", 1786521600000, "974aefb885e265e082f4f1a6006b2cd77472cf63183ca1746d0fc83885bf9ecd"],
];

test("MySQL migration files and journal are an immutable append-only manifest", async () => {
  const directory = new URL("../drizzle-mysql/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assert.deepEqual(files, canonical.map(([name]) => name));
  const snapshots = (await readdir(new URL("meta/", directory))).filter((name) => /^\d{4}_snapshot\.json$/u.test(name)).sort();
  assert.deepEqual(snapshots, canonical.map((_, index) => `${String(index).padStart(4, "0")}_snapshot.json`));
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", directory), "utf8"));
  assert.equal(journal.version, "7");
  assert.equal(journal.dialect, "mysql");
  assert.ok(journal.entries.every(({ version, breakpoints }) => version === "5" && breakpoints === true));
  assert.deepEqual(journal.entries.map(({ idx, tag, when }) => [idx, `${tag}.sql`, when]), canonical.map(([name, when], idx) => [idx, name, when]));
  for (const [name, , expectedHash] of canonical) {
    const actualHash = createHash("sha256").update(await readFile(new URL(name, directory))).digest("hex");
    assert.equal(actualHash, expectedHash, `${name} was rewritten; append a new migration instead`);
  }
  const preflight = await readFile(new URL("../scripts/check-mysql-migration-history.mjs", import.meta.url), "utf8");
  assert.match(preflight, /created_at AS createdAt/u);
  assert.match(preflight, /snapshotHash/u);
  assert.doesNotMatch(preflight, /UPDATE\s+__drizzle_migrations/iu);
});
