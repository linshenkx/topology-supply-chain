import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../app/api/auth/login/route.ts", import.meta.url),
  "utf8",
);

test("wrong-password attempts use a capped database-side increment", () => {
  assert.match(source, /failedAttempts:\s*sql`\$\{authCredentials\.failedAttempts\} \+ 1`/);
  assert.match(source, /lt\(authCredentials\.failedAttempts,\s*5\)/);
  assert.doesNotMatch(source, /credential\.failedAttempts\s*\+\s*1/);
  assert.match(source, /executeAffected\(tx\.update\(authCredentials\)/);
  assert.match(source, /incremented !== 1 && latestAttempts < 5/);
});

test("latest failure count and account lock stay inside one transaction", () => {
  const transactionStart = source.indexOf("const attempts = await withDbTransaction(db, async tx =>");
  const increment = source.indexOf("executeAffected(tx.update(authCredentials)", transactionStart);
  const latestRead = source.indexOf("const [latestCredential] = await tx.select", increment);
  const credentialLock = source.indexOf("lockedAt: attemptedAt", latestRead);
  const accountLock = source.indexOf("accountStatus: \"locked\"", credentialLock);
  const transactionReturn = source.indexOf("return latestAttempts", accountLock);
  const response = source.indexOf("error: attempts >= 5", transactionReturn);

  assert.ok(transactionStart >= 0);
  assert.ok(transactionStart < increment);
  assert.ok(increment < latestRead);
  assert.ok(latestRead < credentialLock);
  assert.ok(credentialLock < accountLock);
  assert.ok(accountLock < transactionReturn);
  assert.ok(transactionReturn < response);
  assert.match(source, /eq\(users\.accountStatus,\s*user\.accountStatus\)/);
  assert.match(source, /`账号或密码错误，还可尝试\$\{5 - attempts\}次。`/);
});

test("successful passwords keep the existing counter reset", () => {
  assert.match(source, /const credentialReset = await withDbTransaction\(db, async tx =>/);
  assert.match(source, /failedAttempts:\s*0,[\s\S]*?lockedAt:\s*null/);
  for (const predicate of [
    /eq\(authCredentials\.failedAttempts,\s*credential\.failedAttempts\)/,
    /eq\(authCredentials\.updatedAt,\s*credential\.updatedAt\)/,
    /isNull\(authCredentials\.lockedAt\)/,
    /lt\(authCredentials\.failedAttempts,\s*5\)/,
    /reset !== 1/,
    /eq\(users\.accountStatus,\s*"active"\)/,
  ]) {
    assert.match(source, predicate);
  }
});

test("account activity is rechecked before sessions and login challenges", () => {
  const trustedBranch = source.indexOf("if (trusted)");
  const trustedActiveCheck = source.indexOf("eq(users.accountStatus, \"active\")", trustedBranch);
  const sessionCreation = source.indexOf("createSession({", trustedBranch);
  const challengeNumber = source.indexOf("const challengeNo = `OTP-", sessionCreation);
  const challengeActiveCheck = source.indexOf("eq(users.accountStatus, \"active\")", challengeNumber);
  const challengeInsert = source.indexOf("db.insert(authChallenges)", challengeNumber);

  assert.ok(trustedBranch < trustedActiveCheck && trustedActiveCheck < sessionCreation);
  assert.ok(challengeNumber < challengeActiveCheck && challengeActiveCheck < challengeInsert);
});
