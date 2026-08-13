import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const upsertSource = fs.readFileSync(new URL("../database/runtime/upsert.ts", import.meta.url), "utf8");
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
  const source = read("apps/api/src/modules/auth/writes.ts");
  assert.match(source, /readLoginChallenge\(transaction, request\.body\.challengeNo, true\)/);
  assert.match(source, /SET attempts = attempts \+ 1/);
  for (const predicate of [
    /verified_at IS NULL/,
    /attempts < \?/,
    /expires_at > \?/,
    /claimed\.affectedRows !== 1/,
    /ON DUPLICATE KEY UPDATE/,
  ]) {
    assert.match(source, predicate);
  }
  const claimedIndex = source.indexOf("if (claimed.affectedRows !== 1)");
  const upsertIndex = source.indexOf("INSERT INTO trusted_devices", claimedIndex);
  const sessionIndex = source.indexOf("insertSession(transaction", upsertIndex);
  assert.ok(claimedIndex < upsertIndex && upsertIndex < sessionIndex);
});

test("step-up OTP uses atomic claim and attempt increment conditions", () => {
  const source = read("apps/api/src/modules/auth/writes.ts");
  assert.match(source, /LIMIT 1 FOR UPDATE/);
  assert.match(source, /SET attempts = attempts \+ 1/);
  for (const predicate of [
    /integer\(challenge\.sessionId\) !== access\.sessionId/,
    /verified_at IS NULL/,
    /attempts < \?/,
    /expires_at > \?/,
    /claimed\.affectedRows !== 1/,
  ]) {
    assert.match(source, predicate);
  }
});
