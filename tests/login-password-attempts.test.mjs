import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../apps/api/src/modules/auth/writes.ts", import.meta.url),
  "utf8",
);

test("wrong-password attempts use a capped database-side increment", () => {
  assert.match(source, /Math\.min\(current\.failedAttempts \+ 1, MAX_ATTEMPTS\)/);
  assert.match(source, /SET failed_attempts = \?/);
  assert.match(source, /WHERE id = \?/);
  assert.match(source, /account_status = 'locked'/);
});

test("latest failure count and account lock stay inside one transaction", () => {
  const transactionStart = source.indexOf("run: async ({ transaction }) =>");
  const latestRead = source.indexOf("readCredential(transaction, account, true)", transactionStart);
  const increment = source.indexOf("SET failed_attempts = ?", latestRead);
  const credentialLock = source.indexOf("locked_at = CASE", increment);
  const accountLock = source.indexOf("account_status = 'locked'", credentialLock);
  const transactionReturn = source.indexOf("return { authenticated: false", accountLock);
  const response = source.indexOf("result.locked !== undefined", transactionReturn);

  assert.ok(transactionStart >= 0);
  assert.ok(transactionStart < latestRead);
  assert.ok(latestRead < increment);
  assert.ok(latestRead < credentialLock);
  assert.ok(credentialLock < accountLock);
  assert.ok(accountLock < transactionReturn);
  assert.ok(transactionReturn < response);
  assert.match(source, /current\.accountStatus !== "active"/);
  assert.match(source, /Account locked after repeated failures/);
});

test("successful passwords keep the existing counter reset", () => {
  assert.match(source, /SET failed_attempts = 0, locked_at = NULL/);
  for (const predicate of [
    /readCredential\(transaction, account, true\)/,
    /current\.accountStatus !== "active"/,
    /WHERE id = \? AND failed_attempts < \?/,
  ]) {
    assert.match(source, predicate);
  }
});

test("account activity is rechecked before sessions and login challenges", () => {
  const lockedRead = source.indexOf("readCredential(transaction, account, true)");
  const activeCheck = source.indexOf('current.accountStatus !== "active"', lockedRead);
  const sessionCreation = source.indexOf("insertSession(transaction", activeCheck);
  const challengeNumber = source.indexOf('deriveChallengeNumber("OTP"', activeCheck);
  const challengeInsert = source.indexOf("INSERT INTO auth_challenges", challengeNumber);

  assert.ok(lockedRead < activeCheck && activeCheck < sessionCreation);
  assert.ok(activeCheck < challengeNumber && challengeNumber < challengeInsert);
});
