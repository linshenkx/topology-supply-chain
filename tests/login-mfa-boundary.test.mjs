import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const loginSource = fs.readFileSync(
  new URL("../app/api/auth/login/route.ts", import.meta.url),
  "utf8",
);
const verifySource = fs.readFileSync(
  new URL("../app/api/auth/verify/route.ts", import.meta.url),
  "utf8",
);

test("login preview behavior uses the shared production boundary", () => {
  assert.match(loginSource, /isLocalPreviewRequest\(\{[\s\S]*?requestUrl:\s*request\.url/);
  for (const marker of ["APP_ENV", "DEPLOY_TARGET", "NODE_ENV"]) {
    assert.match(loginSource, new RegExp(`runtimeEnv\\("${marker}"\\)`));
  }
  assert.doesNotMatch(loginSource, /\["localhost",\s*"127\.0\.0\.1"\]/);
  assert.match(loginSource, /\.\.\.\(local\s*\?\s*\{\s*previewCode:\s*code\s*\}\s*:\s*\{\}\)/);
});

test("trusted-device validity is filtered by the database clock value", () => {
  assert.match(loginSource, /gt\(trustedDevices\.trustedUntil,\s*nowIso\)/);
  assert.doesNotMatch(loginSource, /new Date\(device\.trustedUntil\)/);
});

test("login challenges are scoped and expiration-filtered in the database query", () => {
  assert.match(verifySource, /eq\(authChallenges\.purpose,\s*"login"\)/);
  assert.match(verifySource, /isNull\(authChallenges\.verifiedAt\)/);
  assert.match(verifySource, /gt\(authChallenges\.expiresAt,\s*nowIso\)/);
  assert.doesNotMatch(verifySource, /new Date\(challenge\.expiresAt\)/);
});
