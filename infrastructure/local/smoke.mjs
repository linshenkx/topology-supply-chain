import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

const exec = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const compose = resolve(directory, "docker-compose.yml");
const composeArgs = ["compose", "-f", compose];

async function publishedPort(service, containerPort) {
  const { stdout } = await exec("docker", [...composeArgs, "port", service, String(containerPort)], { windowsHide: true });
  const value = /:(\d+)\s*$/u.exec(stdout)?.[1];
  if (value === undefined) throw new Error(`Published port is unavailable for ${service}:${containerPort}`);
  return Number(value);
}

async function serviceEnvironment(service) {
  const { stdout: idOutput } = await exec("docker", [...composeArgs, "ps", "--all", "-q", service], { windowsHide: true });
  const id = idOutput.trim();
  if (id === "") throw new Error(`Compose service container is unavailable: ${service}`);
  const { stdout } = await exec("docker", ["inspect", id, "--format", "{{json .Config.Env}}"], { windowsHide: true });
  return Object.fromEntries(JSON.parse(stdout).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

const bootstrapEnvironment = await serviceEnvironment("bootstrap");
const httpPort = Number(process.env.LOCAL_HTTP_PORT ?? await publishedPort("nginx", 80));
const mysqlPort = Number(process.env.LOCAL_MYSQL_PORT ?? await publishedPort("mysql", 3306));
const fixtureRunId = process.env.LOCAL_FIXTURE_RUN_ID ?? bootstrapEnvironment.LOCAL_FIXTURE_RUN_ID ?? "local";
const password = process.env.LOCAL_FIXTURE_PASSWORD ?? bootstrapEnvironment.LOCAL_FIXTURE_PASSWORD ?? "LocalTest!2026";
const origin = `http://127.0.0.1:${httpPort}`;

async function json(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw === "" ? undefined : JSON.parse(raw); } catch { payload = raw; }
  return { response, payload };
}

const page = await fetch(origin);
if (!page.ok) throw new Error(`Nginx/Web smoke failed: ${page.status}`);
const health = await json("/api/v1/health/ready");
if (!health.response.ok) throw new Error(`Nginx/API readiness failed: ${health.response.status}`);
const deviceId = `local-compose-${randomUUID()}`;

const login = await json("/api/v1/auth/login", {
  method: "POST",
  headers: { origin, "idempotency-key": `local-login-${randomUUID()}` },
  body: {
    account: `supply_chain.${fixtureRunId}@e2e.invalid`,
    password,
    deviceId,
    deviceName: "local-compose-smoke",
  },
});
if (!login.response.ok) throw new Error(`Local login failed: ${login.response.status} ${JSON.stringify(login.payload)}`);
const code = "123456";
const verified = await json("/api/v1/auth/verify", {
  method: "POST",
  headers: { origin, "idempotency-key": `local-verify-${randomUUID()}` },
  body: { challengeNo: login.payload?.result?.challengeNo, code, deviceName: "local-compose-smoke" },
});
if (!verified.response.ok) throw new Error(`Local OTP verify failed: ${verified.response.status} ${JSON.stringify(verified.payload)}`);
const setCookies = typeof verified.response.headers.getSetCookie === "function"
  ? verified.response.headers.getSetCookie()
  : [verified.response.headers.get("set-cookie")].filter(Boolean);
if (setCookies.some((value) => /;\s*Secure(?:;|$)/iu.test(value))) throw new Error("Local HTTP response unexpectedly emitted Secure cookies");
const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
const csrf = /topology_csrf=([a-f\d]{64})/iu.exec(cookie)?.[1];
if (!csrf) throw new Error("Local login did not issue a CSRF cookie");

const session = await json("/api/v1/session", { headers: { origin, cookie } });
if (!session.response.ok) throw new Error(`Local session failed: ${session.response.status}`);
const stepUp = await json("/api/v1/auth/step-up/request", {
  method: "POST",
  headers: { origin, cookie, "x-csrf-token": csrf, "idempotency-key": `local-step-up-${randomUUID()}` },
  body: {
    action: "local_smoke",
    objectType: "local_smoke",
    objectId: "1",
    objectVersion: 1,
    requestDigest: "a".repeat(64),
  },
});
if (stepUp.response.status !== 201) throw new Error(`Local step-up request failed: ${stepUp.response.status} ${JSON.stringify(stepUp.payload)}`);
const stepUpVerify = await json("/api/v1/auth/step-up/verify", {
  method: "POST",
  headers: { origin, cookie, "x-csrf-token": csrf, "idempotency-key": `local-step-up-verify-${randomUUID()}` },
  body: { challengeNo: stepUp.payload?.result?.challengeNo, code: "123456" },
});
if (!stepUpVerify.response.ok) throw new Error(`Local step-up verify failed: ${stepUpVerify.response.status} ${JSON.stringify(stepUpVerify.payload)}`);

const db = await mysql.createConnection(`mysql://topology:topology-local-only@127.0.0.1:${mysqlPort}/topology_local`);
try {
  const [[beforeAudit]] = await db.query("SELECT COUNT(*) AS total FROM audit_logs");
  const [[beforeOutbox]] = await db.query("SELECT COUNT(*) AS total FROM outbox_messages");
  const [[user]] = await db.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [`supply_chain.${fixtureRunId}@e2e.invalid`]);
  if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) <= 0) throw new Error("Local fixture user is unavailable");
  const suffix = `${Date.now()}`;
  const skuCode = `LOCAL-SMOKE-${suffix}`;
  const created = await json("/api/v1/master-data", {
    method: "POST",
    headers: { origin, cookie, "x-csrf-token": csrf, "idempotency-key": `local-master-${randomUUID()}` },
    body: {
      action: "create_sku",
      code: skuCode,
      name: `Local Compose Smoke ${suffix}`,
      itemType: "auxiliary",
      stockUnit: "EA",
      overproductionTolerance: 0,
      purchaseOverTolerance: 0,
      purchaseUnderTolerance: 0,
    },
  });
  if (created.response.status !== 201) throw new Error(`Local business write failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  const [[sku]] = await db.execute("SELECT COUNT(*) AS total FROM skus WHERE code = ?", [skuCode]);
  const [[audit]] = await db.execute("SELECT COUNT(*) AS total FROM audit_logs WHERE module = 'master_data' AND business_no = ?", [skuCode]);
  const [[afterAudit]] = await db.query("SELECT COUNT(*) AS total FROM audit_logs");
  const [[afterOutbox]] = await db.query("SELECT COUNT(*) AS total FROM outbox_messages");
  if (Number(sku.total) !== 1 || Number(audit.total) !== 1 || Number(afterAudit.total) <= Number(beforeAudit.total) || Number(afterOutbox.total) <= Number(beforeOutbox.total)) {
    throw new Error("Local business write did not produce the expected DB/audit/outbox evidence");
  }

  const fileBytes = Buffer.from("%PDF-1.7\nlocal compose file smoke\n");
  const form = new FormData();
  form.append("category", "import_source");
  form.append("entityType", "import_upload");
  form.append("entityId", String(user.id));
  form.append("file", new Blob([fileBytes], { type: "application/pdf" }), "local-smoke.pdf");
  const uploadResponse = await fetch(`${origin}/api/v1/files`, {
    method: "POST",
    headers: {
      origin,
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": `local-file-${randomUUID()}`,
    },
    body: form,
  });
  const uploadPayload = await uploadResponse.json();
  if (uploadResponse.status !== 201) throw new Error(`Local file upload failed: ${uploadResponse.status} ${JSON.stringify(uploadPayload)}`);
  const fileId = Number(uploadPayload?.result?.file?.id);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error("Local file upload returned an invalid id");

  let scanStatus;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await json(`/api/v1/files/status?id=${fileId}`, { headers: { origin, cookie } });
    if (!status.response.ok) throw new Error(`Local file status failed: ${status.response.status} ${JSON.stringify(status.payload)}`);
    scanStatus = status.payload?.scanStatus;
    if (scanStatus === "clean") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (scanStatus !== "clean") throw new Error(`Local file scan did not complete: ${scanStatus}`);
  const download = await fetch(`${origin}/api/v1/files?id=${fileId}`, { headers: { origin, cookie } });
  const downloadedBytes = Buffer.from(await download.arrayBuffer());
  if (!download.ok || !downloadedBytes.equals(fileBytes)) {
    throw new Error(`Local file download failed: ${download.status}`);
  }
  const [[fileRecord]] = await db.execute(
    "SELECT scan_status AS scanStatus, size_bytes AS sizeBytes FROM file_objects WHERE id = ?",
    [fileId],
  );
  if (fileRecord?.scanStatus !== "clean" || Number(fileRecord.sizeBytes) !== fileBytes.length) {
    throw new Error("Local file DB evidence is incomplete");
  }
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    origin,
    page: page.status,
    apiReady: health.response.status,
    login: login.response.status,
    verify: verified.response.status,
    session: session.response.status,
    stepUpRequest: stepUp.response.status,
    stepUpVerify: stepUpVerify.response.status,
    businessWrite: created.response.status,
    skuRows: Number(sku.total),
    auditRows: Number(audit.total),
    outboxDelta: Number(afterOutbox.total) - Number(beforeOutbox.total),
    fileUpload: uploadResponse.status,
    fileScanStatus: scanStatus,
    fileDownload: download.status,
    fileBytes: downloadedBytes.length,
  })}\n`);
} finally {
  await db.end();
}
