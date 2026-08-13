import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import test from "node:test";

const root = new URL("..", import.meta.url);
const lifecycle = fileURLToPath(new URL("../tooling/e2e/lifecycle.mjs", import.meta.url));
const runtimeRoot = join(tmpdir(), "topology-e2e");
const run = (name, extra = []) => new Promise((resolve, reject) => execFile(process.execPath, [lifecycle, name, "--run", ...extra], { cwd: fileURLToPath(root), windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(JSON.parse(stdout))));
const state = async (runId) => JSON.parse(await readFile(join(runtimeRoot, runId, "state.json"), "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function requestJson(origin, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(`${origin}${path}`, { method: payload ? "POST" : "GET", rejectUnauthorized: false, headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } }, (response) => {
      let raw = ""; response.setEncoding("utf8"); response.on("data", (chunk) => raw += chunk); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: raw ? JSON.parse(raw) : undefined }));
    });
    request.once("error", reject); if (payload) request.end(payload); else request.end();
  });
}
async function unavailable(port) { return new Promise((resolve) => { const socket = createConnection({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); resolve(false); }).once("error", () => resolve(true)); }); }

test("Tier 1 E2E foundation is isolated, fail-closed, HTTPS-cookie capable, and exactly cleanable", { timeout: 420_000 }, async (t) => {
  const suffix = `${Date.now()}-${process.pid}`;
  const first = `e2e-${suffix}-a`; const second = `e2e-${suffix}-b`;
  t.after(async () => { await run("cleanup", [first]).catch(() => undefined); await run("cleanup", [second]).catch(() => undefined); });
  await run("prepare", [first]); await run("prepare", [second]);
  const one = await state(first); const two = await state(second);
  assert.notEqual(one.resources.container, two.resources.container);
  assert.notEqual(one.resources.dbName, two.resources.dbName);
  assert.notEqual(one.resources.ports.mysql, two.resources.ports.mysql);
  await assert.rejects(run("prepare", [first]), /already exists/u);
  assert.equal(one.fixtureSha.length, 64);
  await run("start", [first]);
  await assert.rejects(run("start", [first]), /already started/u);
  const ready = await run("status", [first]); assert.equal(ready.ready, true, JSON.stringify(ready.checks));
  const stub = `http://127.0.0.1:${one.resources.ports.stub}`;
  const controlled = await fetch(`${stub}/control`, { method: "POST", headers: { "content-type": "application/json", "x-e2e-control-token": one.secrets.controlToken }, body: JSON.stringify({ provider: "sms", mode: "fail_once" }) }); assert.equal(controlled.status, 200);
  const failed = await fetch(`${stub}/sms/deliver`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": one.secrets.stubKeys.sms }, body: "{}" }); assert.equal(failed.status, 503);
  const recovered = await fetch(`${stub}/sms/deliver`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": one.secrets.stubKeys.sms }, body: "{}" }); assert.equal(recovered.status, 200);
  const origin = one.origins.https;
  const login = await requestJson(origin, "/api/v1/auth/login", { body: { account: `supply_chain.${first}@e2e.invalid`, password: one.password, deviceId: `${first}-device` }, headers: { origin, "idempotency-key": `${first}-login-0001` } });
  assert.equal(login.status, 200); assert.equal(login.body.result.authenticated, false); assert.match(login.body.result.challengeNo, /^OTP-/u);
  let otp; for (let attempt = 0; attempt < 20; attempt += 1) { const response = await fetch(`${stub}/otp?runId=${first}`, { headers: { "x-e2e-otp-token": one.secrets.otpToken } }); if (response.status === 200) { otp = (await response.json()).code; break; } await delay(500); }
  assert.match(otp, /^\d{6}$/u);
  const wrongRunOtp = await fetch(`${stub}/otp?runId=${second}`, { headers: { "x-e2e-otp-token": one.secrets.otpToken } }); assert.equal(wrongRunOtp.status, 403);
  const verified = await requestJson(origin, "/api/v1/auth/verify", { body: { challengeNo: login.body.result.challengeNo, code: otp }, headers: { origin, "idempotency-key": `${first}-verify-0001` } });
  assert.equal(verified.status, 200); const cookies = verified.headers["set-cookie"]; assert.equal(cookies.length, 2); assert.ok(cookies.every((value) => /; Secure; SameSite=Strict/u.test(value)));
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; "); const csrf = /topology_csrf=([a-f\d]{64})/iu.exec(cookie)?.[1]; assert.match(csrf, /^[a-f\d]{64}$/iu);
  const csrfRejected = await requestJson(origin, "/api/v1/auth/logout", { body: {}, headers: { origin, cookie, "idempotency-key": `${first}-logout-reject` } }); assert.equal(csrfRejected.status, 403);
  const loggedOut = await requestJson(origin, "/api/v1/auth/logout", { body: {}, headers: { origin, cookie, "x-csrf-token": csrf, "idempotency-key": `${first}-logout-0001` } }); assert.equal(loggedOut.status, 200);
  const events = await (await fetch(`${stub}/events`)).json(); assert.ok(events.events.length >= 1); assert.ok(events.events.every((event) => event.runId === first && !Object.hasOwn(event, "code") && !Object.hasOwn(event, "url")));
  const evidencePath = join(runtimeRoot, first, "safe-evidence.json"); await run("evidence", [first, "--out", evidencePath]); const evidence = JSON.parse(await readFile(evidencePath, "utf8")); assert.equal(evidence.secretsRecorded, false); assert.equal(evidence.fixtureManifestSha, one.fixtureSha);
  await run("stop", [first]); await run("cleanup", [first]); await run("cleanup", [second]);
  assert.equal(await unavailable(one.resources.ports.https), true); assert.equal(await unavailable(one.resources.ports.mysql), true);
  await assert.rejects(stat(join(runtimeRoot, first))); await assert.rejects(stat(join(runtimeRoot, second)));
});
