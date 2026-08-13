import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { assertFrozenMysqlMigrationRepository } from "../../database/tooling/mysql-migration-manifest.mjs";
import { fixtureSha, seedScopeAFixture } from "./fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = join(tmpdir(), "topology-e2e");
const [command, ...rest] = process.argv.slice(2);
const argument = (name) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
const runId = argument("--run") ?? process.env.RUN_ID;
const validRunId = (value) => typeof value === "string" && /^e2e-[a-z0-9][a-z0-9-]{5,80}$/u.test(value);
const fail = (message) => { throw new Error(message); };
const now = () => new Date().toISOString();
const token = (bytes = 24) => randomBytes(bytes).toString("hex");
const runPath = (id) => join(runtimeRoot, id);
const statePath = (id) => join(runPath(id), "state.json");
const safe = (state) => ({ runId: state.runId, repositorySha: state.repositorySha, fixtureSha: state.fixtureSha, fixture: state.fixture, resources: state.resources, origins: state.origins, createdAt: state.createdAt, startedAt: state.startedAt });
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function requireRun() { if (!validRunId(runId)) fail("A lowercase e2e RUN_ID is required (for example e2e-20260813-ab12)"); return runId; }
async function readState(id = requireRun()) { try { return JSON.parse(await readFile(statePath(id), "utf8")); } catch { fail(`No E2E state exists for ${id}`); } }
async function saveState(state) { await writeFile(statePath(state.runId), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
function run(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(commandName, args, { cwd: root, windowsHide: true, ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolvePromise({ stdout, stderr }));
    child.once("error", reject);
  });
}
async function capture(file, commandName, args, options = {}) {
  const output = join(options.cwd ?? root, file);
  const child = spawn(commandName, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stream = createWriteStream(output, { flags: "a" });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  await new Promise((resolvePromise, reject) => child.once("error", reject).once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${commandName} exited ${code}`))));
}
async function reservePort() { const server = createServer(); await new Promise((resolvePromise, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolvePromise)); const address = server.address(); await new Promise((resolvePromise) => server.close(resolvePromise)); return address.port; }
async function waitFor(label, action, timeoutMs = 30_000) { const until = Date.now() + timeoutMs; let last; while (Date.now() < until) { try { const result = await action(); if (result) return result; } catch (error) { last = error; } await new Promise((resolvePromise) => setTimeout(resolvePromise, 500)); } fail(`${label} did not become ready${last ? `: ${last.message}` : ""}`); }
function isLoopback(value) { const url = new URL(value); return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && !url.username && !url.password; }
async function json(url, options = {}) { const response = await fetch(url, { signal: AbortSignal.timeout(3_000), ...options }); let body; try { body = await response.json(); } catch { body = undefined; } return { response, body }; }
function httpsJson(url, headers = {}) { return new Promise((resolvePromise, reject) => { const request = https.get(url, { rejectUnauthorized: false, headers, timeout: 3_000 }, (response) => { let raw = ""; response.setEncoding("utf8"); response.on("data", (chunk) => raw += chunk); response.on("end", () => resolvePromise({ status: response.statusCode, body: raw })); }); request.once("error", reject).once("timeout", () => request.destroy(new Error("HTTPS timeout"))); }); }
function portOpen(port) { return new Promise((resolvePromise) => { const socket = createServer(); socket.once("error", (error) => resolvePromise(error.code === "EADDRINUSE")); socket.listen(port, "127.0.0.1", () => socket.close(() => resolvePromise(false))); }); }
function childProcess(entry, args, env, logPath, cwd = root) { const log = openSync(logPath, "a"); const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, detached: true, stdio: ["ignore", log, log] }); child.unref(); return child; }
async function stopPid(pid) { if (!pid) return; await run("taskkill", ["/pid", String(pid), "/t", "/f"]).catch(() => undefined); }
async function dockerContainer(state) { const { stdout } = await run("docker", ["inspect", "--format", "{{ index .Config.Labels \"topology.e2e.run_id\" }}", state.resources.container]); return stdout.trim() === state.runId; }
async function applyMigrations(databaseUrl) { await assertFrozenMysqlMigrationRepository(); const connection = await mysql.createConnection(databaseUrl); try { await migrate(drizzle(connection), { migrationsFolder: join(root, "database", "migrations", "mysql") }); } finally { await connection.end(); } }
async function openSslConfig() {
  if (process.env.OPENSSL_CONF) return process.env.OPENSSL_CONF;
  for (const candidate of ["C:/Program Files/Git/mingw64/etc/ssl/openssl.cnf", "C:/Program Files/Git/usr/ssl/openssl.cnf"]) {
    try { await stat(candidate); return candidate; } catch {}
  }
  fail("OpenSSL configuration is unavailable; set OPENSSL_CONF to a local openssl.cnf");
}

async function prepare() {
  const id = requireRun(); const folder = runPath(id); try { await stat(folder); fail(`E2E RUN_ID already exists: ${id}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(join(folder, "logs"), { recursive: true });
  const ports = { mysql: await reservePort(), stub: await reservePort(), worker: await reservePort(), api: await reservePort(), web: await reservePort(), https: await reservePort() };
  const dbName = `e2e_${id.replaceAll("-", "_")}`; const dbPassword = token(); const rootPassword = token(); const container = `topology-e2e-mysql-${id}`;
  const databaseUrl = `mysql://e2e_app:${encodeURIComponent(dbPassword)}@127.0.0.1:${ports.mysql}/${dbName}`;
  const state = { runId: id, createdAt: now(), repositorySha: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(), fixtureSha: await fixtureSha(), databaseUrl, rootPassword, password: token(18), secrets: { signingKey: token(32), otpKey: token(32), stubKeys: { email: token(), sms: token(), scan: token() }, controlToken: token(), otpToken: token() }, resources: { container, dbName, ports, pids: {} }, origins: { https: `https://127.0.0.1:${ports.https}`, api: `http://127.0.0.1:${ports.api}`, worker: `http://127.0.0.1:${ports.worker}` } };
  try {
    await capture("logs/docker.log", "docker", ["run", "--detach", "--rm", "--name", container, "--label", `topology.e2e.run_id=${id}`, "--publish", `127.0.0.1:${ports.mysql}:3306`, "--env", `MYSQL_ROOT_PASSWORD=${rootPassword}`, "--env", `MYSQL_DATABASE=${dbName}`, "--env", "MYSQL_USER=e2e_app", "--env", `MYSQL_PASSWORD=${dbPassword}`, "mysql:8.4"], { cwd: folder });
    await waitFor("MySQL", async () => { const connection = await mysql.createConnection({ uri: databaseUrl, connectTimeout: 2_000 }); await connection.end(); return true; }, 90_000);
    await applyMigrations(databaseUrl);
    const connection = await mysql.createConnection(databaseUrl); try {
      await connection.execute("UPDATE writer_fences SET enabled=1 WHERE (resource='outbox.worker' AND owner='worker-v1' AND generation=2) OR (resource='auth.commands' AND owner='fastify-v1' AND generation=2)");
      state.fixture = await seedScopeAFixture(connection, { runId: id, password: state.password });
    } finally { await connection.end(); }
    await saveState(state); await writeFile(join(folder, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, ...safe(state), ready: false, blockedReasons: ["services_not_started"], providers: { sms: "local-stub", email: "local-stub", fileScan: "local-stub", workerReady: false }, database: { loopbackOnly: true, resourcePrefix: `${id}-`, cleanupOwner: id } }, null, 2)}\n`);
    print({ status: "prepared", ...safe(state) });
  } catch (error) { await cleanupState(state).catch(() => undefined); throw error; }
}

async function start() {
  const state = await readState(); if (Object.keys(state.resources.pids).length) fail("E2E services already started; use status or stop first");
  for (const origin of Object.values(state.origins)) if (!isLoopback(origin)) fail("Non-loopback origin rejected");
  for (const artifact of ["apps/api/dist/server.js", "apps/worker/dist/server.js", "apps/web/node_modules/vinext/dist/cli.js"]) { try { await stat(join(root, artifact)); } catch { fail(`Missing build artifact ${artifact}; run pnpm build:api && pnpm build:worker && pnpm build:web:preview`); } }
  const folder = runPath(state.runId); const logs = join(folder, "logs"); const ports = state.resources.ports; const stubOrigin = `http://127.0.0.1:${ports.stub}`;
  const common = { ...process.env, E2E_RUN_ID: state.runId };
  const stub = childProcess(join(root, "tooling/e2e/stub-provider.mjs"), [], { ...common, E2E_STUB_PORT: String(ports.stub), E2E_STUB_KEYS_JSON: JSON.stringify(state.secrets.stubKeys), E2E_STUB_CONTROL_TOKEN: state.secrets.controlToken, E2E_STUB_OTP_TOKEN: state.secrets.otpToken }, join(logs, "stub.log"));
  state.resources.pids.stub = stub.pid; await saveState(state);
  await waitFor("provider stub", async () => (await json(`${stubOrigin}/health`)).response.ok);
  const worker = childProcess(join(root, "apps/worker/dist/server.js"), [], { ...common, DATABASE_URL: state.databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(ports.worker), OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: state.secrets.otpKey }), SMS_WEBHOOK_URL: `${stubOrigin}/sms/deliver`, SMS_WEBHOOK_HEALTH_URL: `${stubOrigin}/sms/health`, SMS_WEBHOOK_API_KEY: state.secrets.stubKeys.sms, EMAIL_WEBHOOK_URL: `${stubOrigin}/email/deliver`, EMAIL_WEBHOOK_HEALTH_URL: `${stubOrigin}/email/health`, EMAIL_WEBHOOK_API_KEY: state.secrets.stubKeys.email, FILE_SCAN_WEBHOOK_URL: `${stubOrigin}/scan/deliver`, FILE_SCAN_WEBHOOK_HEALTH_URL: `${stubOrigin}/scan/health`, FILE_SCAN_WEBHOOK_API_KEY: state.secrets.stubKeys.scan }, join(logs, "worker.log"));
  state.resources.pids.worker = worker.pid; await saveState(state); await waitFor("worker", async () => (await json(`${state.origins.worker}/health/ready`)).response.ok);
  const api = childProcess(join(root, "apps/api/dist/server.js"), [], { ...common, APP_ENV: "production", DEPLOY_TARGET: "e2e", DATABASE_URL: state.databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(ports.api), API_SESSION_SIGNING_KEY: state.secrets.signingKey, OTP_SEALING_KEY_ID: "v1", OTP_SEALING_KEY: state.secrets.otpKey, WORKER_INTERNAL_URL: state.origins.worker, DOMAIN_REGISTRATION_MODULES: "../modules/r2-master-procurement/index.js,../r3/manifest.js" }, join(logs, "api.log"));
  state.resources.pids.api = api.pid; await saveState(state); await waitFor("API", async () => (await json(`${state.origins.api}/api/v1/health/ready`)).response.ok);
  const web = childProcess(join(root, "apps/web/node_modules/vinext/dist/cli.js"), ["dev", "--port", String(ports.web), "--host", "127.0.0.1"], common, join(logs, "web.log"), join(root, "apps/web"));
  state.resources.pids.web = web.pid; await saveState(state); await waitFor("Web", async () => (await fetch(`http://127.0.0.1:${ports.web}`, { signal: AbortSignal.timeout(3_000) })).ok, 60_000);
  const cert = join(folder, "cert.pem"), key = join(folder, "key.pem");
  await capture("logs/cert.log", "openssl", ["req", "-config", await openSslConfig(), "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { cwd: folder });
  const proxy = childProcess(join(root, "tooling/e2e/https-proxy.mjs"), [], { ...common, E2E_HTTPS_PORT: String(ports.https), E2E_API_PORT: String(ports.api), E2E_WEB_PORT: String(ports.web), E2E_CERT_PATH: cert, E2E_KEY_PATH: key }, join(logs, "https.log"));
  state.resources.pids.https = proxy.pid; state.startedAt = now(); await saveState(state);
  await waitFor("HTTPS proxy", async () => (await httpsJson(`${state.origins.https}/_e2e/health`)).status === 200);
  print({ status: "started", ...safe(state) });
}

async function status() {
  const state = await readState(); const checks = {};
  checks.containerOwner = await dockerContainer(state).catch(() => false);
  checks.fixtureSha = (await fixtureSha()) === state.fixtureSha;
  checks.pids = Object.values(state.resources.pids).length === 5 && (await Promise.all([state.resources.ports.stub, state.resources.ports.worker, state.resources.ports.api, state.resources.ports.web, state.resources.ports.https].map(portOpen))).every(Boolean);
  checks.providers = (await json(`http://127.0.0.1:${state.resources.ports.stub}/health`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.worker = (await json(`${state.origins.worker}/health/ready`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.api = (await json(`${state.origins.api}/api/v1/health/ready`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.https = (await httpsJson(`${state.origins.https}/_e2e/health`).catch(() => ({ status: 0 }))).status === 200;
  checks.web = (await fetch(`http://127.0.0.1:${state.resources.ports.web}`, { signal: AbortSignal.timeout(3_000) }).catch(() => ({ ok: false }))).ok;
  checks.migration = await (async () => { const { stdout } = await run(process.execPath, ["tooling/release/check-mysql-migration-history.mjs"], { env: { ...process.env, DATABASE_URL: state.databaseUrl } }); return /5\/5 canonical entries applied/u.test(stdout); })().catch(() => false);
  const ready = Object.values(checks).every(Boolean); print({ status: ready ? "ready" : "blocked", ready, checks, ...safe(state) }); if (!ready) process.exitCode = 2;
}

async function stop() { const state = await readState(); for (const pid of Object.values(state.resources.pids)) await stopPid(pid); state.resources.pids = {}; await saveState(state); print({ status: "stopped", runId: state.runId }); }
async function cleanupState(state) { for (const pid of Object.values(state.resources.pids ?? {})) await stopPid(pid); if (await dockerContainer(state).catch(() => false)) await run("docker", ["rm", "--force", state.resources.container]); await rm(runPath(state.runId), { recursive: true, force: true }); }
async function cleanup() { const state = await readState(); await cleanupState(state); print({ status: "cleaned", runId: state.runId }); }
async function evidence() { const state = await readState(); const out = argument("--out") ?? join(runPath(state.runId), "evidence-manifest.json"); const snapshot = { schemaVersion: 1, runId: state.runId, repositorySha: state.repositorySha, tier: "tier1", fixtureManifestSha: state.fixtureSha, environment: { webOrigin: state.origins.https, apiOrigin: state.origins.https, workerOrigin: state.origins.worker, loopbackOnly: true }, commands: [], scenarios: [], resources: { pids: Object.keys(state.resources.pids), ports: Object.values(state.resources.ports), testPrefix: `E2E-${state.runId}-`, cleanup: "not-needed" }, secretsRecorded: false, generatedAt: now() }; await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), `${JSON.stringify(snapshot, null, 2)}\n`); print({ status: "evidence_written", runId: state.runId, evidenceSha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") }); }

if (command === "prepare") await prepare(); else if (command === "start") await start(); else if (command === "status") await status(); else if (command === "stop") await stop(); else if (command === "cleanup") await cleanup(); else if (command === "evidence") await evidence(); else fail("Usage: lifecycle.mjs prepare|start|status|stop|cleanup|evidence --run <RUN_ID>");
