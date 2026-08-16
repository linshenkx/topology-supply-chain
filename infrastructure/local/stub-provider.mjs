import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3003);
const apiKeys = JSON.parse(process.env.LOCAL_STUB_KEYS_JSON ?? "{}");
const controlToken = process.env.LOCAL_STUB_CONTROL_TOKEN;

if (!Number.isInteger(port) || port < 1 || typeof controlToken !== "string" || controlToken.length < 16) {
  throw new Error("Local stub configuration is invalid");
}

const state = { otp: undefined, events: [] };

function authorized(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function provider(pathname) {
  const match = /^\/(email|sms|scan)\/(health|deliver)$/.exec(pathname);
  return match ? { name: match[1], operation: match[2] } : undefined;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") return send(response, 200, { status: "ok", mode: "local-only" });
  if (url.pathname === "/otp" && request.method === "GET") {
    if (!authorized(request.headers["x-local-control-token"], controlToken)) return send(response, 403, { error: "forbidden" });
    if (typeof state.otp !== "string") return send(response, 404, { error: "otp_unavailable" });
    return send(response, 200, { code: state.otp });
  }
  if (url.pathname === "/events" && request.method === "GET") {
    if (!authorized(request.headers["x-local-control-token"], controlToken)) return send(response, 403, { error: "forbidden" });
    return send(response, 200, { events: state.events });
  }
  const target = provider(url.pathname);
  if (!target || request.method !== (target.operation === "health" ? "GET" : "POST")) return send(response, 404, { error: "not_found" });
  if (!authorized(request.headers["x-api-key"], apiKeys[target.name])) return send(response, 401, { error: "unauthorized" });
  if (target.operation === "health") return send(response, 200, { status: "ok", provider: target.name });
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const payload = JSON.parse(raw || "{}");
  if (target.name === "sms" && typeof payload.code === "string" && /^\d{6}$/.test(payload.code)) state.otp = payload.code;
  state.events.push({ provider: target.name, operation: "deliver", outcome: "accepted", at: new Date().toISOString() });
  return send(response, 200, target.name === "scan" ? { status: "clean" } : { status: "ok" });
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
