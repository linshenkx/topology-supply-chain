import assert from "node:assert/strict";
import test from "node:test";

import { readOtpSealingConfig, sealOtp } from "../dist/platform/secrets.js";

test("OTP outbox sealing is versioned, rotatable, and never contains plaintext", () => {
  const config = readOtpSealingConfig({ OTP_SEALING_KEY_ID: "v7", OTP_SEALING_KEY: "ab".repeat(32) });
  const first = sealOtp(config, "482915");
  const second = sealOtp(config, "482915");
  assert.equal(first.keyId, "v7");
  assert.notEqual(first.iv, second.iv);
  assert.doesNotMatch(JSON.stringify(first), /482915/u);
  assert.throws(() => readOtpSealingConfig({ OTP_SEALING_KEY_ID: "v7", OTP_SEALING_KEY: "short" }), /required/u);
});
