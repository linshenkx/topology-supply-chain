import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { deliverSms, readWorkerProviders, scanFile } from "../dist/providers.js";

function seal(key, keyId, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { keyId, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

test("provider configuration fails fast when any delivery or health boundary is absent", () => {
  assert.throws(() => readWorkerProviders({}), /SMS_WEBHOOK_URL|OTP_SEALING/u);
});

test("SMS is unsealed only in memory and scanner responses are contract checked", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body, key: request.headers["idempotency-key"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/scan" ? { status: "clean" } : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const key = Buffer.alloc(32, 7);
  const environment = {
    OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: key.toString("hex") }),
    SMS_WEBHOOK_URL: `${origin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${origin}/health`,
    EMAIL_WEBHOOK_URL: `${origin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${origin}/health`,
    FILE_SCAN_WEBHOOK_URL: `${origin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${origin}/health`,
  };
  const providers = readWorkerProviders(environment);
  const sealedCode = seal(key, "v1", "482915");
  await deliverSms(providers, { mobile: "13800000000", sealedCode, purpose: "login" }, "sms-idem-12345678");
  assert.match(requests[0].body, /482915/u);
  assert.doesNotMatch(requests[0].body, /ciphertext|sealedCode/u);
  assert.equal(await scanFile(providers, JSON.stringify({ fileId: 1 }), "scan-idem-123456"), "clean");
  assert.equal(requests[1].key, "scan-idem-123456");
});
