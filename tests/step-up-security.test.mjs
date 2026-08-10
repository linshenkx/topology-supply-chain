import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const policySource = fs.readFileSync(
  new URL("../app/lib/step-up-policy.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(policySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const policyModule = { exports: {} };
vm.runInNewContext(transpiled, {
  module: policyModule,
  exports: policyModule.exports,
  Number,
});
const {
  normalizeStepUpScope,
  isPreviewStepUpVerification,
  PREVIEW_STEP_UP_CHALLENGE,
} = policyModule.exports;

const mutationSource = fs.readFileSync(
  new URL("../db/insert-one.ts", import.meta.url),
  "utf8",
);
const mutationTranspiled = ts.transpileModule(mutationSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const mutationModule = { exports: {} };
vm.runInNewContext(mutationTranspiled, {
  module: mutationModule,
  exports: mutationModule.exports,
  Number,
});
const { executeAffected } = mutationModule.exports;

const read = (relativePath) => fs.readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  "utf8",
);

test("step-up scopes are restricted and bound to a concrete entity", () => {
  for (const scope of [
    "approval:18",
    "finance:record_payment:31",
    "finance:request_record_correction:42",
    "finance:release_invoice_risk:53",
  ]) {
    assert.equal(normalizeStepUpScope(scope), scope);
  }
  for (const scope of [
    "approval:0",
    "approval:-1",
    "finance-payment",
    "finance:record_payment",
    "finance:record_refund:1",
    "admin:delete_everything:1",
  ]) {
    assert.equal(normalizeStepUpScope(scope), null);
  }
});

test("local preview accepts only the documented fixed challenge and code", () => {
  assert.equal(isPreviewStepUpVerification(PREVIEW_STEP_UP_CHALLENGE, "123456"), true);
  assert.equal(isPreviewStepUpVerification(PREVIEW_STEP_UP_CHALLENGE, "000000"), false);
  assert.equal(isPreviewStepUpVerification("forged", "123456"), false);
});

test("server consumption is user, purpose, scope, verification and expiry bound", () => {
  const source = read("app/lib/step-up.ts");
  for (const predicate of [
    /eq\(authChallenges\.challengeNo, challengeNo\)/,
    /eq\(authChallenges\.userId, input\.userId\)/,
    /eq\(authChallenges\.purpose, "high_risk"\)/,
    /eq\(authChallenges\.deviceId, scope\)/,
    /isNotNull\(authChallenges\.verifiedAt\)/,
    /gte\(authChallenges\.expiresAt, nowIso\)/,
  ]) {
    assert.match(source, predicate);
  }
  assert.match(source, /executeAffected\(db\.delete\(authChallenges\)/);
  assert.match(source, /consumed !== 1/);
});

test("affected-row normalization supports D1 and MySQL mutation results", async () => {
  assert.equal(await executeAffected({ run: async () => ({ changes: 1 }) }), 1);
  assert.equal(await executeAffected({ run: async () => ({ meta: { changes: 2 } }) }), 2);
  assert.equal(await executeAffected({ execute: async () => [{ affectedRows: 3 }] }), 3);
});

test("finance actions no longer trust a client smsVerified boolean", () => {
  const route = read("app/api/finance/route.ts");
  assert.doesNotMatch(route, /body\.smsVerified/);
  for (const scope of [
    "finance:record_payment:",
    "finance:request_record_correction:",
    "finance:release_invoice_risk:",
  ]) {
    assert.match(route, new RegExp(scope));
  }

  const clients = [
    read("app/components/FinanceWorkspace.tsx"),
    read("app/components/FinanceExceptionWorkspace.tsx"),
  ].join("\n");
  assert.doesNotMatch(clients, /smsVerified\s*:\s*true/);
  assert.match(clients, /challengeNo/);
  assert.match(clients, /setPaying\(row\);setSmsVerified\(false\);setChallengeNo\(""\)/);
});

test("approval proofs are bound to the selected approval and consumed server-side", () => {
  const route = read("app/api/approvals/route.ts");
  const page = read("app/page.tsx");
  assert.doesNotMatch(route, /body\.smsVerified/);
  assert.match(route, /scope: `approval:\$\{approval\.id\}`/);
  assert.match(page, /scope: `approval:\$\{selected\.id\}`/);
  assert.match(page, /challengeNo: selected\.highRisk \? challengeNo/);
});

test("approval proof consumption and pending-state CAS share the claim transaction", () => {
  const route = read("app/api/approvals/route.ts");
  const claimStart = route.indexOf("const claimApproval");
  const claimEnd = route.indexOf("if (!correctionApproval)", claimStart);
  const claim = route.slice(claimStart, claimEnd);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.ok(claim.indexOf("consumeVerifiedStepUp") < claim.indexOf("executeAffected"));
  assert.match(claim, /eq\(approvalRequests\.status, "pending"\)/);
  assert.match(claim, /claimed !== 1/);
  assert.match(claim, /new AccessError\(409/);
  assert.match(route, /await withDbTransaction\(db, claimApproval\)/);

  const correctionTransaction = route.slice(
    route.indexOf("await withDbTransaction(db, async tx =>", route.indexOf("financial_record_correction")),
  );
  assert.ok(correctionTransaction.indexOf("await claimApproval(tx)") >= 0);
  assert.ok(correctionTransaction.indexOf("await claimApproval(tx)") < correctionTransaction.indexOf("await tx.insert(paymentRecords)"));
  assert.doesNotMatch(route, /await (?:db|tx)\.update\(approvalRequests\)\.set\(approvalUpdate\)/);
});

test("stored OTP hashes are salted with their challenge number", () => {
  const requestRoute = read("app/api/auth/step-up/request/route.ts");
  const verifyRoute = read("app/api/auth/step-up/verify/route.ts");
  assert.match(requestRoute, /hashSecret\(`\$\{challengeNo\}:\$\{code\}`\)/);
  assert.match(verifyRoute, /hashSecret\(`\$\{challenge\.challengeNo\}:\$\{body\.code!\}`\)/);
});
