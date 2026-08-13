import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const policySource = fs.readFileSync(
  new URL("../apps/web/app/lib/step-up-policy.ts", import.meta.url),
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
  new URL("../database/runtime/insert-one.ts", import.meta.url),
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
  const source = read("apps/web/app/lib/step-up.ts");
  for (const predicate of [
    /eq\(authChallenges\.challengeNo, challengeNo\)/,
    /eq\(authChallenges\.userId, input\.userId\)/,
    /eq\(authChallenges\.sessionId, input\.sessionId\)/,
    /eq\(authChallenges\.action, input\.action\)/,
    /eq\(authChallenges\.objectVersion, input\.objectVersion!\)/,
    /eq\(authChallenges\.requestDigest, input\.requestDigest!\.toLowerCase\(\)\)/,
    /eq\(authChallenges\.purpose, "high_risk"\)/,
    /eq\(authChallenges\.deviceId, scope\)/,
    /isNotNull\(authChallenges\.verifiedAt\)/,
    /gte\(authChallenges\.expiresAt, nowIso\)/,
  ]) {
    assert.match(source, predicate);
  }
  assert.match(source, /executeAffected\(db\.delete\(authChallenges\)/);
  assert.ok(source.indexOf("const [binding] = await db.select") < source.indexOf("db.delete(authChallenges)"));
  assert.match(source, /binding\.objectVersion !== input\.objectVersion/);
  assert.match(source, /new AccessError\(409, "对象版本已经变化/);
  assert.match(source, /consumed !== 1/);
  assert.doesNotMatch(source, /Date\.parse/u);
  assert.match(source, /TIMESTAMPDIFF\(MICROSECOND/u);
  assert.match(source, /GREATEST\(CURRENT_TIMESTAMP\(3\), DATE_ADD/u);
});

test("affected-row normalization supports D1 and MySQL mutation results", async () => {
  assert.equal(await executeAffected({ run: async () => ({ changes: 1 }) }), 1);
  assert.equal(await executeAffected({ run: async () => ({ meta: { changes: 2 } }) }), 2);
  assert.equal(await executeAffected({ execute: async () => [{ affectedRows: 3 }] }), 3);
});

test("finance actions no longer trust a client smsVerified boolean", () => {
  const route = read("apps/web/app/api/finance/route.ts");
  assert.doesNotMatch(route, /body\.smsVerified/);
  for (const scope of [
    "finance:record_payment:",
    "finance:request_record_correction:",
    "finance:release_invoice_risk:",
  ]) {
    assert.match(route, new RegExp(scope));
  }

  const clients = [
    read("apps/web/app/components/FinanceWorkspace.tsx"),
    read("apps/web/app/components/FinanceExceptionWorkspace.tsx"),
  ].join("\n");
  assert.doesNotMatch(clients, /smsVerified\s*:\s*true/);
  assert.doesNotMatch(clients, /Date\.parse/u);
  assert.match(clients, /objectVersion/);
  assert.match(clients, /challengeNo/);
  assert.match(clients, /setPaying\(row\);setSmsVerified\(false\);setChallengeNo\(""\)/);
});

test("approval proofs are bound to the selected approval and consumed server-side", () => {
  const route = read("apps/web/app/api/approvals/route.ts");
  const handler = read("apps/api/src/r3/approval-handler.ts");
  const page = read("apps/web/app/page.tsx");
  assert.doesNotMatch(route, /body\.smsVerified/);
  assert.match(handler, /objectType: "approval"/);
  assert.match(handler, /objectId: String\(id\)/);
  assert.match(handler, /consumeStepUpClaim/);
  assert.match(page, /objectVersion: selected\.objectVersion, requestDigest/);
  assert.match(page, /\.\.\.\(selected\.highRisk \? \{ challengeNo \} : \{\}\)/);
});

test("approval proof consumption and pending-state CAS share the claim transaction", () => {
  const route = read("apps/web/app/api/approvals/route.ts");
  const claimStart = route.indexOf("const claimApproval");
  const claimEnd = route.indexOf("if (!correctionApproval)", claimStart);
  const claim = route.slice(claimStart, claimEnd);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.ok(claim.indexOf("lockApprovalRequestRow") < claim.indexOf("consumeVerifiedStepUp"));
  assert.ok(claim.indexOf("databaseObjectVersion") < claim.indexOf("consumeVerifiedStepUp"));
  assert.ok(claim.indexOf("consumeVerifiedStepUp") < claim.indexOf("executeAffected"));
  assert.match(claim, /eq\(approvalRequests\.status, "pending"\)/);
  assert.match(claim, /claimed !== 1/);
  assert.match(claim, /new AccessError\(409/);
  assert.match(route, /await withDbTransaction\(db, claimApproval\)/);

  const correctionTransaction = route.slice(
    route.indexOf("await withLockedFinancialRows(db", route.indexOf('approval.workflowType === "financial_record_correction"')),
  );
  assert.ok(correctionTransaction.indexOf("await claimApproval(tx)") >= 0);
  assert.ok(correctionTransaction.indexOf("await claimApproval(tx)") < correctionTransaction.indexOf("await tx.insert(paymentRecords)"));
  assert.doesNotMatch(route, /await (?:db|tx)\.update\(approvalRequests\)\.set\(approvalUpdate\)/);
});

test("finance locks and rereads authoritative versions before consuming proofs", () => {
  const route = read("apps/web/app/api/finance/route.ts");
  for (const marker of ["withLockedInvoiceException", "lockPaymentRecordRow", "withLockedPaymentRequest"]) {
    assert.match(route, new RegExp(marker));
  }
  for (const scope of ["release_invoice_risk", "request_record_correction", "record_payment"]) {
    const start = route.indexOf(`action: "${scope}"`);
    assert.ok(start >= 0);
  }
  assert.match(route, /objectVersion: exception\.objectVersion/);
  assert.match(route, /objectVersion: original\.objectVersion/);
  assert.match(route, /objectVersion: paymentRequest\.objectVersion/);
  assert.match(route, /eq\(invoiceExceptions\.updatedAt, exception\.updatedAt\)/);
  assert.match(route, /eq\(factoryPaymentRequests\.updatedAt, paymentRequest\.updatedAt\)/);
});

test("stored OTP hashes are salted with their challenge number", () => {
  const source = read("apps/api/src/modules/auth/writes.ts");
  assert.match(source, /sha256\(`\$\{challengeNo\}:\$\{code\}`\)/);
  assert.match(source, /sha256\(`\$\{request\.body\.challengeNo\}:\$\{request\.body\.code\}`\)/);
});
