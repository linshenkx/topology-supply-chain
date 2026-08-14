import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { assertFrozenMysqlMigrationRepository } from "../../database/tooling/mysql-migration-manifest.mjs";
import { fixtureSha, seedScopeAFixture } from "./fixtures.mjs";
import { RELEASE_MANIFEST } from "../release/release-manifest.mjs";
import { resolveFenceProfile } from "./fence-profiles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeRoot = join(tmpdir(), "topology-e2e");
const integrityRoot = join(tmpdir(), "topology-e2e-integrity");
const [command, ...rest] = process.argv.slice(2);
const argument = (name) => { const index = rest.indexOf(name); return index < 0 ? undefined : rest[index + 1]; };
const runId = argument("--run") ?? process.env.RUN_ID;
const validRunId = (value) => typeof value === "string" && /^e2e-[a-z0-9][a-z0-9-]{5,80}$/u.test(value);
const fail = (message) => { throw new Error(message); };
const now = () => new Date().toISOString();
const token = (bytes = 24) => randomBytes(bytes).toString("hex");
const runPath = (id) => join(runtimeRoot, id);
const statePath = (id) => join(runPath(id), "state.json");
const integrityPath = (id) => join(integrityRoot, `${id}.key`);
const safe = (state) => ({ runId: state.runId, repositorySha: state.repositorySha, fixtureSha: state.fixtureSha, fixtureModuleSha: state.fixtureModuleSha, buildIdentity: state.buildIdentity, fenceProfile: state.fenceProfile, fixture: state.fixture, resources: { ...state.resources, pids: Object.fromEntries(Object.entries(state.resources.pids ?? {}).map(([name, record]) => [name, { pid: record.pid, name: record.name }])) }, origins: state.origins, createdAt: state.createdAt, startedAt: state.startedAt });
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function requireRun() { if (!validRunId(runId)) fail("A lowercase e2e RUN_ID is required (for example e2e-20260813-ab12)"); return runId; }
function unsigned(state) { const value = { ...state }; delete value.integrity; return value; }
function stateTag(key, state) { return createHmac("sha256", key).update(JSON.stringify(unsigned(state))).digest("hex"); }
async function readState(id = requireRun()) {
  let state; try { state = JSON.parse(await readFile(statePath(id), "utf8")); } catch { fail(`No E2E state exists for ${id}`); }
  let key; try { key = await readFile(integrityPath(id), "utf8"); } catch { fail(`E2E state integrity key is missing for ${id}`); }
  const actual = stateTag(key, state); const expected = typeof state.integrity === "string" ? state.integrity : "";
  if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) fail(`E2E state integrity validation failed for ${id}`);
  return state;
}
async function saveState(state) { const key = await readFile(integrityPath(state.runId), "utf8"); state.integrity = stateTag(key, state); await writeFile(statePath(state.runId), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); }
function childEnvironment(extra = {}) {
  const env = {}; const allowed = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"];
  for (const name of allowed) if (typeof process.env[name] === "string") env[name] = process.env[name];
  env.Path = process.env.Path ?? process.env.PATH ?? "";
  env.PATH = env.Path;
  env.NO_PROXY = "127.0.0.1,localhost,::1"; env.no_proxy = env.NO_PROXY;
  return { ...env, ...extra };
}
function run(commandName, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(commandName, args, { cwd: root, windowsHide: true, env: childEnvironment(options.env), ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolvePromise({ stdout, stderr }));
    child.once("error", reject);
  });
}
async function capture(file, commandName, args, options = {}) {
  const output = join(options.cwd ?? root, file);
  const child = spawn(commandName, args, { cwd: options.cwd ?? root, env: childEnvironment(options.env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
function childProcess(state, name, entry, args, env, logPath, cwd = root) {
  const log = openSync(logPath, "a"); const ownerToken = token(24); const wrapper = join(root, "tooling/e2e/child-wrapper.mjs");
  const child = spawn(process.execPath, [wrapper, "--run", state.runId, "--owner-token", ownerToken, "--entry", entry, "--", ...args], { cwd, env: childEnvironment(env), windowsHide: true, detached: true, stdio: ["ignore", log, log] });
  child.unref(); return { pid: child.pid, name, ownerToken, entry };
}
async function processCommandLine(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("Invalid E2E process identifier");
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 3 }; [Console]::Out.Write($p.CommandLine)`;
  try { return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).stdout; } catch (error) {
    if (error?.code === 3) return undefined;
    throw error;
  }
}
async function verifyOwnedProcess(state, record) {
  if (!record || !Number.isSafeInteger(record.pid) || typeof record.ownerToken !== "string" || typeof record.entry !== "string") fail("E2E process state is invalid");
  const commandLine = await processCommandLine(record.pid);
  if (commandLine === undefined) return false;
  const markers = ["child-wrapper.mjs", `--run ${state.runId}`, record.ownerToken, record.entry];
  if (!markers.every((marker) => commandLine.includes(marker))) fail(`Refusing to stop non-owner or reused PID ${record.pid}`);
  return true;
}
async function stopProcesses(state) {
  const records = Object.values(state.resources.pids ?? {});
  const live = (await Promise.all(records.map(async (record) => (await verifyOwnedProcess(state, record)) ? record : undefined))).filter(Boolean);
  for (const record of live) await run("taskkill", ["/pid", String(record.pid), "/t", "/f"]);
}
async function dockerContainer(state) { const { stdout } = await run("docker", ["inspect", "--format", "{{ index .Config.Labels \"topology.e2e.run_id\" }}", state.resources.container]); return stdout.trim() === state.runId; }
async function applyMigrations(databaseUrl) { await assertFrozenMysqlMigrationRepository(); const connection = await mysql.createConnection(databaseUrl); try { await migrate(drizzle(connection), { migrationsFolder: join(root, "database", "migrations", "mysql") }); } finally { await connection.end(); } }
async function fileSha(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function directorySha(path) {
  const entries = await readdir(path, { withFileTypes: true }); const parts = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const full = join(path, entry.name); parts.push(entry.isDirectory() ? `${entry.name}/${await directorySha(full)}` : `${entry.name}:${await fileSha(full)}`); }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
async function currentBuildIdentity() {
  const api = join(root, "apps/api/dist"), worker = join(root, "apps/worker/dist"), webBuild = join(root, "apps/web/dist"), webSource = join(root, "apps/web/app"), webEntry = join(root, "apps/web/node_modules/vinext/dist/cli.js");
  for (const artifact of [api, worker, webBuild, webSource, webEntry]) { try { await stat(artifact); } catch { fail(`Missing build artifact ${artifact}; run the documented E2E builds first`); } }
  // vinext dev regenerates apps/web/dist while it is serving. The immutable
  // runtime identity is therefore its actual CLI entry plus source inputs;
  // API/Worker run their immutable compiled dist trees directly.
  const entries = { apiDist: await directorySha(api), workerDist: await directorySha(worker), webSource: await directorySha(webSource), webEntry: await fileSha(webEntry) };
  return { ...entries, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}
const fixtureModuleSha = () => fileSha(join(root, "tooling/e2e/fixtures.mjs"));
const releaseResourceMap = new Map(RELEASE_MANIFEST.writer.resources.map((item) => [item.resource, item]));
async function applyFenceProfile(databaseUrl, profile) {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await connection.query("SELECT resource, owner, generation, enabled FROM writer_fences ORDER BY resource");
    const actual = new Map(rows.map((row) => [row.resource, row]));
    for (const [resource, expected] of releaseResourceMap) { const row = actual.get(resource); if (!row || row.owner !== expected.owner || Number(row.generation) !== expected.generation) fail(`Writer fence identity mismatch: ${resource}`); }
    for (const resource of profile.resources) { if (!releaseResourceMap.has(resource)) fail(`Frozen fence profile contains unknown resource: ${resource}`); await connection.execute("UPDATE writer_fences SET enabled=1 WHERE resource=? AND owner=? AND generation=?", [resource, releaseResourceMap.get(resource).owner, releaseResourceMap.get(resource).generation]); }
  } finally { await connection.end(); }
}
async function fenceProfileReady(databaseUrl, profile) {
  const connection = await mysql.createConnection(databaseUrl);
  try {
    const [rows] = await connection.query("SELECT resource, owner, generation, enabled FROM writer_fences ORDER BY resource"); const actual = new Map(rows.map((row) => [row.resource, row]));
    for (const [resource, expected] of releaseResourceMap) { const row = actual.get(resource); const enabled = Number(row?.enabled) === 1; if (!row || row.owner !== expected.owner || Number(row.generation) !== expected.generation || enabled !== profile.resources.includes(resource)) return false; }
    // A canonical migration-era legacy fence can exist disabled. It can never
    // be selected by an E2E profile; any enabled unknown resource fails closed.
    return rows.every((row) => releaseResourceMap.has(row.resource) || Number(row.enabled) === 0);
  } finally { await connection.end(); }
}
async function openSslConfig() {
  if (process.env.OPENSSL_CONF) return process.env.OPENSSL_CONF;
  for (const candidate of ["C:/Program Files/Git/mingw64/etc/ssl/openssl.cnf", "C:/Program Files/Git/usr/ssl/openssl.cnf"]) {
    try { await stat(candidate); return candidate; } catch {}
  }
  fail("OpenSSL configuration is unavailable; set OPENSSL_CONF to a local openssl.cnf");
}

async function prepare() {
  const id = requireRun(); const folder = runPath(id); try { await stat(folder); fail(`E2E RUN_ID already exists: ${id}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const profile = resolveFenceProfile(argument("--fence-profile"));
  await mkdir(join(folder, "logs"), { recursive: true }); await mkdir(integrityRoot, { recursive: true }); await writeFile(integrityPath(id), token(32), { mode: 0o600 });
  const ports = { mysql: await reservePort(), stub: await reservePort(), worker: await reservePort(), api: await reservePort(), web: await reservePort(), https: await reservePort() };
  const dbName = `e2e_${id.replaceAll("-", "_")}`; const dbPassword = token(); const rootPassword = token(); const container = `topology-e2e-mysql-${id}`;
  const databaseUrl = `mysql://e2e_app:${encodeURIComponent(dbPassword)}@127.0.0.1:${ports.mysql}/${dbName}`;
  const state = { runId: id, createdAt: now(), repositorySha: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(), fixtureSha: await fixtureSha(), fixtureModuleSha: await fixtureModuleSha(), buildIdentity: await currentBuildIdentity(), fenceProfile: profile, databaseUrl, rootPassword, password: token(18), secrets: { signingKey: token(32), otpKey: token(32), stubKeys: { email: token(), sms: token(), scan: token() }, controlToken: token(), otpToken: token() }, resources: { container, dbName, ports, pids: {} }, origins: { https: `https://127.0.0.1:${ports.https}`, api: `http://127.0.0.1:${ports.api}`, worker: `http://127.0.0.1:${ports.worker}` } };
  try {
    await capture("logs/docker.log", "docker", ["run", "--detach", "--rm", "--name", container, "--label", `topology.e2e.run_id=${id}`, "--publish", `127.0.0.1:${ports.mysql}:3306`, "--env", `MYSQL_ROOT_PASSWORD=${rootPassword}`, "--env", `MYSQL_DATABASE=${dbName}`, "--env", "MYSQL_USER=e2e_app", "--env", `MYSQL_PASSWORD=${dbPassword}`, "mysql:8.4"], { cwd: folder });
    await waitFor("MySQL", async () => { const connection = await mysql.createConnection({ uri: databaseUrl, connectTimeout: 2_000 }); await connection.end(); return true; }, 90_000);
    await applyMigrations(databaseUrl);
    const connection = await mysql.createConnection(databaseUrl); try {
      await applyFenceProfile(databaseUrl, profile);
      state.fixture = await seedScopeAFixture(connection, { runId: id, password: state.password });
    } finally { await connection.end(); }
    await saveState(state); await writeFile(join(folder, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, ...safe(state), ready: false, blockedReasons: ["services_not_started"], providers: { sms: "local-stub", email: "local-stub", fileScan: "local-stub", workerReady: false }, database: { loopbackOnly: true, resourcePrefix: `${id}-`, cleanupOwner: id } }, null, 2)}\n`);
    print({ status: "prepared", ...safe(state) });
  } catch (error) { await cleanupState(state, { allowUnsigned: true }).catch(() => undefined); throw error; }
}

async function start() {
  const state = await readState(); if (Object.keys(state.resources.pids).length) fail("E2E services already started; use status or stop first");
  for (const origin of Object.values(state.origins)) if (!isLoopback(origin)) fail("Non-loopback origin rejected");
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== state.repositorySha || (await fixtureSha()) !== state.fixtureSha || (await fixtureModuleSha()) !== state.fixtureModuleSha || (await currentBuildIdentity()).sha256 !== state.buildIdentity.sha256 || !(await fenceProfileReady(state.databaseUrl, state.fenceProfile))) fail("E2E identity or test fence profile changed; re-run prepare");
  const folder = runPath(state.runId); const logs = join(folder, "logs"); const ports = state.resources.ports; const stubOrigin = `http://127.0.0.1:${ports.stub}`;
  const common = { E2E_RUN_ID: state.runId };
  const stub = childProcess(state, "stub", join(root, "tooling/e2e/stub-provider.mjs"), [], { ...common, E2E_STUB_PORT: String(ports.stub), E2E_STUB_KEYS_JSON: JSON.stringify(state.secrets.stubKeys), E2E_STUB_CONTROL_TOKEN: state.secrets.controlToken, E2E_STUB_OTP_TOKEN: state.secrets.otpToken }, join(logs, "stub.log"));
  state.resources.pids.stub = stub; await saveState(state);
  await waitFor("provider stub", async () => (await json(`${stubOrigin}/health`)).response.ok);
  if (argument("--inject-failure-after") === "stub") fail("Injected E2E partial-start failure after stub");
  const worker = childProcess(state, "worker", join(root, "apps/worker/dist/server.js"), [], { ...common, DATABASE_URL: state.databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(ports.worker), OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: state.secrets.otpKey }), SMS_WEBHOOK_URL: `${stubOrigin}/sms/deliver`, SMS_WEBHOOK_HEALTH_URL: `${stubOrigin}/sms/health`, SMS_WEBHOOK_API_KEY: state.secrets.stubKeys.sms, EMAIL_WEBHOOK_URL: `${stubOrigin}/email/deliver`, EMAIL_WEBHOOK_HEALTH_URL: `${stubOrigin}/email/health`, EMAIL_WEBHOOK_API_KEY: state.secrets.stubKeys.email, FILE_SCAN_WEBHOOK_URL: `${stubOrigin}/scan/deliver`, FILE_SCAN_WEBHOOK_HEALTH_URL: `${stubOrigin}/scan/health`, FILE_SCAN_WEBHOOK_API_KEY: state.secrets.stubKeys.scan }, join(logs, "worker.log"));
  state.resources.pids.worker = worker; await saveState(state); await waitFor("worker", async () => (await json(`${state.origins.worker}/health/ready`)).response.ok);
  const api = childProcess(state, "api", join(root, "apps/api/dist/server.js"), [], { ...common, APP_ENV: "production", DEPLOY_TARGET: "e2e", DATABASE_URL: state.databaseUrl, DB_SSL: "disabled", HOST: "127.0.0.1", PORT: String(ports.api), API_SESSION_SIGNING_KEY: state.secrets.signingKey, OTP_SEALING_KEY_ID: "v1", OTP_SEALING_KEY: state.secrets.otpKey, WORKER_INTERNAL_URL: state.origins.worker, DOMAIN_REGISTRATION_MODULES: "../composition/supply-writes-manifest.js,../composition/operations-writes-manifest.js" }, join(logs, "api.log"));
  state.resources.pids.api = api; await saveState(state); await waitFor("API", async () => (await json(`${state.origins.api}/api/v1/health/ready`)).response.ok);
  const web = childProcess(state, "web", join(root, "apps/web/node_modules/vinext/dist/cli.js"), ["dev", "--port", String(ports.web), "--host", "127.0.0.1"], common, join(logs, "web.log"), join(root, "apps/web"));
  state.resources.pids.web = web; await saveState(state); await waitFor("Web", async () => (await fetch(`http://127.0.0.1:${ports.web}`, { signal: AbortSignal.timeout(3_000) })).ok, 120_000);
  const cert = join(folder, "cert.pem"), key = join(folder, "key.pem");
  await capture("logs/cert.log", "openssl", ["req", "-config", await openSslConfig(), "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { cwd: folder });
  const proxy = childProcess(state, "https", join(root, "tooling/e2e/https-proxy.mjs"), [], { ...common, E2E_HTTPS_PORT: String(ports.https), E2E_API_PORT: String(ports.api), E2E_WEB_PORT: String(ports.web), E2E_CERT_PATH: cert, E2E_KEY_PATH: key }, join(logs, "https.log"));
  state.resources.pids.https = proxy; state.startedAt = now(); await saveState(state);
  await waitFor("HTTPS proxy", async () => (await httpsJson(`${state.origins.https}/_e2e/health`)).status === 200);
  print({ status: "started", ...safe(state) });
}

async function status() {
  const state = await readState(); const checks = {};
  checks.containerOwner = await dockerContainer(state).catch(() => false);
  checks.fixtureSha = (await fixtureSha()) === state.fixtureSha;
  checks.fixtureModule = (await fixtureModuleSha()) === state.fixtureModuleSha;
  checks.repositorySha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim() === state.repositorySha;
  checks.buildIdentity = (await currentBuildIdentity()).sha256 === state.buildIdentity.sha256;
  checks.fenceProfile = state.fenceProfile?.sha256 === resolveFenceProfile(state.fenceProfile?.name).sha256 && await fenceProfileReady(state.databaseUrl, state.fenceProfile);
  checks.pids = Object.values(state.resources.pids).length === 5 && (await Promise.all(Object.values(state.resources.pids).map((record) => verifyOwnedProcess(state, record).catch(() => false)))) .every(Boolean) && (await Promise.all([state.resources.ports.stub, state.resources.ports.worker, state.resources.ports.api, state.resources.ports.web, state.resources.ports.https].map(portOpen))).every(Boolean);
  checks.providers = (await json(`http://127.0.0.1:${state.resources.ports.stub}/health`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.worker = (await json(`${state.origins.worker}/health/ready`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.api = (await json(`${state.origins.api}/api/v1/health/ready`).catch(() => ({ response: { ok: false } }))).response.ok;
  checks.https = (await httpsJson(`${state.origins.https}/_e2e/health`).catch(() => ({ status: 0 }))).status === 200;
  checks.web = (await fetch(`http://127.0.0.1:${state.resources.ports.web}`, { signal: AbortSignal.timeout(3_000) }).catch(() => ({ ok: false }))).ok;
  checks.migration = await (async () => { const { stdout } = await run(process.execPath, ["tooling/release/check-mysql-migration-history.mjs"], { env: { DATABASE_URL: state.databaseUrl } }); return /5\/5 canonical entries applied/u.test(stdout); })().catch(() => false);
  const ready = Object.values(checks).every(Boolean); print({ status: ready ? "ready" : "blocked", ready, checks, ...safe(state) }); if (!ready) process.exitCode = 2;
}

async function stop() { const state = await readState(); await stopProcesses(state); state.resources.pids = {}; await saveState(state); print({ status: "stopped", runId: state.runId }); }
async function cleanupState(state, { allowUnsigned = false } = {}) {
  if (!allowUnsigned && Object.keys(state.resources.pids ?? {}).length) await stopProcesses(state);
  if (await dockerContainer(state).catch(() => false)) await run("docker", ["rm", "--force", state.resources.container]);
  await rm(runPath(state.runId), { recursive: true, force: true }); await rm(integrityPath(state.runId), { force: true });
}
async function cleanup() { const state = await readState(); await cleanupState(state); print({ status: "cleaned", runId: state.runId }); }
async function evidence() { const state = await readState(); const out = argument("--out") ?? join(runPath(state.runId), "evidence-manifest.json"); const snapshot = { schemaVersion: 1, runId: state.runId, repositorySha: state.repositorySha, tier: "tier1", fixtureManifestSha: state.fixtureSha, fixtureModuleSha: state.fixtureModuleSha, buildIdentity: state.buildIdentity.sha256, fenceProfile: state.fenceProfile.name, environment: { webOrigin: state.origins.https, apiOrigin: state.origins.https, workerOrigin: state.origins.worker, loopbackOnly: true }, commands: [], scenarios: [], resources: { pids: Object.keys(state.resources.pids), ports: Object.values(state.resources.ports), testPrefix: `E2E-${state.runId}-`, cleanup: "not-needed" }, secretsRecorded: false, generatedAt: now() }; await mkdir(dirname(resolve(out)), { recursive: true }); await writeFile(resolve(out), `${JSON.stringify(snapshot, null, 2)}\n`); print({ status: "evidence_written", runId: state.runId, evidenceSha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") }); }

if (command === "prepare") await prepare(); else if (command === "start") await start(); else if (command === "status") await status(); else if (command === "stop") await stop(); else if (command === "cleanup") await cleanup(); else if (command === "evidence") await evidence(); else fail("Usage: lifecycle.mjs prepare|start|status|stop|cleanup|evidence --run <RUN_ID>");
