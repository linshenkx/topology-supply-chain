import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const port = Number(process.env.E2E_STUB_PORT);
const runId = process.env.E2E_RUN_ID;
const apiKeys = JSON.parse(process.env.E2E_STUB_KEYS_JSON ?? "{}");
const controlToken = process.env.E2E_STUB_CONTROL_TOKEN;
const otpToken = process.env.E2E_STUB_OTP_TOKEN;
if (!Number.isInteger(port) || port < 1 || !runId || !controlToken || !otpToken) throw new Error("E2E stub configuration is invalid");

const state = { events: [], modes: { email: "ok", sms: "ok", scan: "ok" }, otp: undefined };
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function authorized(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function providerFrom(pathname) {
  const match = /^\/(email|sms|scan)\/(health|deliver)$/.exec(pathname);
  return match ? { provider: match[1], operation: match[2] } : undefined;
}
function runAuthorized(request, url, token) { return authorized(request.headers["x-e2e-control-token"], token) && url.searchParams.get("runId") === runId; }

const server = createServer(async (request, response) => {
  if (!loopback.has(request.socket.remoteAddress ?? "")) return send(response, 403, { error: "loopback_required" });
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") return send(response, 200, { status: "ok", runId, environmentIsolated: process.env.E2E_HOSTILE_PROVIDER_URL === undefined && process.env.HTTPS_PROXY === undefined && process.env.HTTP_PROXY === undefined });
  if (url.pathname === "/events") {
    if (!runAuthorized(request, url, controlToken)) return send(response, 403, { error: "forbidden" });
    return send(response, 200, { runId, events: state.events });
  }
  if (url.pathname === "/otp" && request.method === "GET") {
    if (!authorized(request.headers["x-e2e-otp-token"], otpToken) || url.searchParams.get("runId") !== runId) return send(response, 403, { error: "forbidden" });
    if (!state.otp) return send(response, 404, { error: "otp_unavailable" });
    const code = state.otp;
    state.otp = undefined;
    return send(response, 200, { code, runId });
  }
  if (url.pathname === "/control" && request.method === "POST") {
    if (!runAuthorized(request, url, controlToken)) return send(response, 403, { error: "forbidden" });
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (!["email", "sms", "scan"].includes(body.provider) || !["ok", "fail_once", "fail"].includes(body.mode)) return send(response, 400, { error: "invalid_control" });
    state.modes[body.provider] = body.mode;
    return send(response, 200, { status: "ok", runId });
  }
  const target = providerFrom(url.pathname);
  if (!target || request.method !== (target.operation === "health" ? "GET" : "POST")) return send(response, 404, { error: "not_found" });
  if (!authorized(request.headers["x-api-key"], apiKeys[target.provider])) return send(response, 401, { error: "unauthorized" });
  if (target.operation === "health") return send(response, 200, { status: "ok", provider: target.provider, runId });
  let raw = ""; for await (const chunk of request) raw += chunk;
  const mode = state.modes[target.provider];
  if (mode === "fail" || mode === "fail_once") {
    if (mode === "fail_once") state.modes[target.provider] = "ok";
    return send(response, 503, { error: "controlled_failure" });
  }
  const payload = JSON.parse(raw || "{}");
  if (target.provider === "sms" && typeof payload.code === "string" && /^\d{6}$/.test(payload.code)) state.otp = payload.code;
  // Events are intentionally structural only: no payload digest, keys, OTP or
  // any other value that could become an offline guessing oracle.
  state.events.push({ provider: target.provider, operation: "deliver", outcome: "accepted", at: new Date().toISOString(), runId });
  return send(response, 200, target.provider === "scan" ? { status: "clean" } : { status: "ok" });
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
