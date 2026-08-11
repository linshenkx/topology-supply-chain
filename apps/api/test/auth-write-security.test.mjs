import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deriveChallengeNumber, deriveOtpCode } from "../dist/modules/auth/writes.js";

test("same idempotency key is isolated across principals and step-up sessions", () => {
  const key = "test-signing-key-with-at-least-32-characters";
  const idempotencyKey = "shared-idempotency-key-0001";
  assert.notEqual(
    deriveOtpCode(key, "auth.login", "user:7", idempotencyKey),
    deriveOtpCode(key, "auth.login", "user:8", idempotencyKey),
  );
  assert.notEqual(
    deriveChallengeNumber("HR", key, "user:7:session:11", idempotencyKey),
    deriveChallengeNumber("HR", key, "user:7:session:12", idempotencyKey),
  );
});

test("password verification is derived only after the current credential row is locked", async () => {
  const source = await readFile(new URL("../src/modules/auth/writes.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("run: async ({ transaction })", source.indexOf("/api/v1/auth/login")));
  const lock = run.indexOf("readCredential(transaction, account, true)");
  const verify = run.indexOf("passwordHash(body.password, current.passwordSalt)");
  const session = run.indexOf("insertSession(transaction");
  assert.ok(lock >= 0 && lock < verify && verify < session);
  assert.doesNotMatch(source.slice(source.indexOf("const account"), source.indexOf("run: async", source.indexOf("const account"))), /passwordHash/u);
});
