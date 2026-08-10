import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const upsertSource = fs.readFileSync(new URL("../db/upsert.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(upsertSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const upsertModule = { exports: {} };
vm.runInNewContext(transpiled, {
  module: upsertModule,
  exports: upsertModule.exports,
  Error,
});
const { executeUpsert } = upsertModule.exports;

const read = (relativePath) => fs.readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  "utf8",
);

test("cross-dialect upsert selects D1 and MySQL builder methods", async () => {
  const calls = [];
  const set = { trustedUntil: "future" };
  const conflictTarget = ["userId", "deviceId"];
  await executeUpsert({
    onConflictDoUpdate: async (options) => calls.push(["d1", options]),
  }, { conflictTarget, set });
  await executeUpsert({
    onDuplicateKeyUpdate: async (options) => calls.push(["mysql", options]),
  }, { conflictTarget, set });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "d1");
  assert.equal(calls[0][1].target, conflictTarget);
  assert.equal(calls[0][1].set, set);
  assert.equal(calls[1][0], "mysql");
  assert.equal(calls[1][1].set, set);
  await assert.rejects(executeUpsert({}, { conflictTarget, set }), /不支持更新或新增记录/);
});

test("login OTP uses atomic claim and attempt increment conditions", () => {
  const source = read("app/api/auth/verify/route.ts");
  assert.match(source, /executeUpsert\(db\.insert\(trustedDevices\)\.values\(trustedDevice\)/);
  assert.doesNotMatch(source, /\.onConflictDoUpdate\(/);
  assert.match(source, /attempts:\s*sql`\$\{authChallenges\.attempts\} \+ 1`/);
  for (const predicate of [
    /isNull\(authChallenges\.verifiedAt\)/,
    /gt\(authChallenges\.expiresAt,\s*verifiedAt\)/,
    /lt\(authChallenges\.attempts,\s*5\)/,
    /claimed !== 1/,
    /incremented !== 1/,
  ]) {
    assert.match(source, predicate);
  }
  const claimedIndex = source.indexOf("if (claimed !== 1)");
  const activeAccountIndex = source.indexOf("eq(users.accountStatus, \"active\")");
  const upsertIndex = source.indexOf("executeUpsert(db.insert(trustedDevices)");
  assert.ok(claimedIndex < activeAccountIndex && activeAccountIndex < upsertIndex);
});

test("step-up OTP uses atomic claim and attempt increment conditions", () => {
  const source = read("app/api/auth/step-up/verify/route.ts");
  assert.match(source, /attempts:\s*sql`\$\{authChallenges\.attempts\} \+ 1`/);
  for (const predicate of [
    /isNull\(authChallenges\.verifiedAt\)/,
    /gt\(authChallenges\.expiresAt,\s*verifiedAt\)/,
    /lt\(authChallenges\.attempts,\s*5\)/,
    /claimed !== 1/,
    /incremented !== 1/,
  ]) {
    assert.match(source, predicate);
  }
});
