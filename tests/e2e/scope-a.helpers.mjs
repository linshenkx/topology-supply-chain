import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import mysql from "mysql2/promise";

const root = new URL("../..", import.meta.url);
const lifecycle = fileURLToPath(new URL("../../tooling/e2e/lifecycle.mjs", import.meta.url));
const runtimeRoot = join(tmpdir(), "topology-e2e");

export function lifecycleRun(command, runId, extra = []) {
  return new Promise((resolve, reject) => execFile(process.execPath, [lifecycle, command, "--run", runId, ...extra], {
    cwd: fileURLToPath(root), windowsHide: true, maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(JSON.parse(stdout))));
}

export async function state(runId) {
  return JSON.parse(await readFile(join(runtimeRoot, runId, "state.json"), "utf8"));
}

export async function withScenario(t, name, profile, run) {
  const runId = `e2e-t2-${name}-${Date.now()}-${process.pid}`.replace(/[^a-z0-9-]/gu, "");
  t.after(() => lifecycleRun("cleanup", runId).catch(() => undefined));
  await lifecycleRun("prepare", runId, ["--fence-profile", profile]);
  await lifecycleRun("start", runId);
  const runtime = await state(runId);
  const ready = await lifecycleRun("status", runId);
  if (!ready.ready) throw new Error(`E2E readiness failed: ${JSON.stringify(ready.checks)}`);
  const db = await mysql.createConnection(runtime.databaseUrl);
  try { return await run({ runId, runtime, db, evidence: [] }); }
  finally { await db.end(); await lifecycleRun("stop", runId).catch(() => undefined); }
}

export function requestJson(origin, path, { method = "POST", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(`${origin}${path}`, { method, rejectUnauthorized: false,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    }, (response) => { let raw = ""; response.setEncoding("utf8"); response.on("data", (chunk) => raw += chunk); response.on("end", () => {
      let parsed; try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
      resolve({ status: response.statusCode, headers: response.headers, body: parsed });
    }); });
    request.once("error", reject); request.end(payload);
  });
}

async function otp(runtime) {
  for (let index = 0; index < 80; index += 1) {
    const response = await fetch(`http://127.0.0.1:${runtime.resources.ports.stub}/otp?runId=${runtime.runId}`, { headers: { "x-e2e-otp-token": runtime.secrets.otpToken } });
    if (response.status === 200) return (await response.json()).code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("OTP did not reach local provider stub");
}

export async function stubControl(runtime, provider, mode) {
  const response = await fetch(`http://127.0.0.1:${runtime.resources.ports.stub}/control?runId=${runtime.runId}`, {
    method: "POST", headers: { "content-type": "application/json", "x-e2e-control-token": runtime.secrets.controlToken }, body: JSON.stringify({ provider, mode }),
  });
  if (response.status !== 200) throw new Error(`Local provider control failed: ${response.status}`);
}

export async function signIn(runtime, account = "supply_chain") {
  const origin = runtime.origins.browser;
  const login = await requestJson(origin, "/api/v1/auth/login", { body: {
    account: `${account}.${runtime.runId}@e2e.invalid`, password: runtime.password, deviceId: `${runtime.runId}-${account}`,
  }, headers: { origin, "idempotency-key": `${runtime.runId}-${account}-login-${randomUUID()}` } });
  const code = await otp(runtime);
  const verified = await requestJson(origin, "/api/v1/auth/verify", { body: { challengeNo: login.body?.result?.challengeNo, code }, headers: { origin, "idempotency-key": `${runtime.runId}-${account}-verify-${randomUUID()}` } });
  const cookie = (verified.headers["set-cookie"] ?? []).map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = /topology_csrf=([a-f\d]{64})/iu.exec(cookie)?.[1];
  if (login.status !== 200 || verified.status !== 200 || !csrf) throw new Error(`Login failed: ${login.status}/${verified.status}`);
  return { origin, cookie, csrf };
}

export async function command(session, path, body, { method = "POST", key = randomUUID() } = {}) {
  const headers = { origin: session.origin, cookie: session.cookie, "idempotency-key": key };
  if (session.csrf) headers["x-csrf-token"] = session.csrf;
  return requestJson(session.origin, path, { method, body, headers });
}

export async function seedReturnEvidence(db, { runId, productReturnId, ownerUserId, factoryId }) {
  const [result] = await db.execute(
    "INSERT INTO file_objects (object_key,file_name,content_type,size_bytes,category,entity_type,entity_id,owner_user_id,factory_id,scan_status) VALUES (?,?, 'application/pdf',32,'quality_evidence','product_return',?,?,?,'clean')",
    [`E2E-${runId}/return-${productReturnId}-evidence.pdf`, "return-evidence.pdf", String(productReturnId), ownerUserId, factoryId],
  );
  return result.insertId;
}

export function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function safeHttp(path, response) { return { path, status: response.status, bodySha256: digest(response.body ?? null), code: response.body?.code ?? null }; }
