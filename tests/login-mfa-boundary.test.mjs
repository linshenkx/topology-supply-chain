import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const loginSource = fs.readFileSync(
  new URL("../apps/api/src/modules/auth/writes.ts", import.meta.url),
  "utf8",
);
const verifySource = fs.readFileSync(
  new URL("../apps/api/src/modules/auth/writes.ts", import.meta.url),
  "utf8",
);

test("login preview behavior uses the shared production boundary", () => {
  assert.match(loginSource, /function isPreview\(options: AuthWriteOptions\)/);
  for (const marker of ["appEnv", "deployTarget", "nodeEnv"]) {
    assert.match(loginSource, new RegExp(`environment\\?\\.${marker}`));
  }
  assert.doesNotMatch(loginSource, /\["localhost",\s*"127\.0\.0\.1"\]/);
  assert.match(loginSource, /\.\.\.\(isPreview\(options\) \? \{ previewCode: code \} : \{\}\)/);
});

test("trusted-device validity is filtered by the database clock value", () => {
  assert.match(loginSource, /trusted_until > \?/);
  assert.doesNotMatch(loginSource, /new Date\(device\.trustedUntil\)/);
});

test("login challenges are scoped and expiration-filtered in the database query", () => {
  assert.match(verifySource, /purpose = 'login'/);
  assert.match(verifySource, /challenge\.verifiedAt !== null \|\| challenge\.expiresAt <= at\.toISOString\(\)/);
  assert.match(verifySource, /verified_at IS NULL AND attempts < \? AND expires_at > \?/);
  assert.doesNotMatch(verifySource, /new Date\(challenge\.expiresAt\)/);
});
