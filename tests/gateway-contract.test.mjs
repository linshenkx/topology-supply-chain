import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { buildForwardedHeaders, routeTarget } from "../tooling/e2e/gateway-routing.mjs";

const gatewayPath = new URL("../tooling/e2e/gateway.mjs", import.meta.url);

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function port(server) { return server.address().port; }

async function gatewayRequest(origin, path, headers = {}) {
  const response = await fetch(`${origin}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

test("single Gateway routes exact /api/v1 and descendants to API, pages to Web", () => {
  const ports = { api: 3001, web: 3000 };
  assert.equal(routeTarget("/api/v1", ports), 3001);
  assert.equal(routeTarget("/api/v1/auth/login", ports), 3001);
  assert.equal(routeTarget("/", ports), 3000);
  assert.equal(routeTarget("/api/health", ports), 3000);
});

test("Gateway overwrites forwarded transport metadata and clears forged identity headers", () => {
  const headers = buildForwardedHeaders({
    host: "127.0.0.1:4000",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
    "oai-authenticated-user-email": "forged@example.com",
    cookie: "topology_session=token",
  }, "http");
  assert.equal(headers.host, "127.0.0.1:4000");
  assert.equal(headers["x-forwarded-host"], "127.0.0.1:4000");
  assert.equal(headers["x-forwarded-proto"], "http");
  assert.equal(headers["oai-authenticated-user-email"], undefined);
  assert.equal(headers.cookie, "topology_session=token");
});

test("actual HTTP Gateway forwards exact API paths and pages, clearing forged identity headers", async (t) => {
  const captures = { api: [], web: [] };
  const api = await listen((request, response) => {
    captures.api.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ owner: "api", path: request.url }));
  });
  const web = await listen((request, response) => {
    captures.web.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ owner: "web", path: request.url }));
  });
  const gatewayPort = await (async () => {
    const probe = await listen((_request, response) => response.end());
    const value = port(probe);
    await new Promise((resolve) => probe.close(resolve));
    return value;
  })();
  const child = spawn(process.execPath, [fileURLToPath(gatewayPath)], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      E2E_GATEWAY_TRANSPORT: "http",
      E2E_GATEWAY_PORT: String(gatewayPort),
      E2E_API_PORT: String(port(api)),
      E2E_WEB_PORT: String(port(web)),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => web.close(resolve))]);
  });
  const origin = `http://127.0.0.1:${gatewayPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${origin}/_e2e/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, stderr);
  const exact = await gatewayRequest(origin, "/api/v1", { "oai-authenticated-user-email": "forged@example.com" });
  const nested = await gatewayRequest(origin, "/api/v1/auth/login");
  const page = await gatewayRequest(origin, "/dashboard", { "oai-authenticated-user-email": "forged@example.com" });
  assert.equal(exact.body.owner, "api");
  assert.equal(nested.body.owner, "api");
  assert.equal(page.body.owner, "web");
  assert.equal(captures.api[0]["oai-authenticated-user-email"], undefined);
  assert.equal(captures.web[0]["oai-authenticated-user-email"], undefined);
  assert.equal(captures.api[0]["x-forwarded-proto"], "http");
  assert.equal(captures.api[0]["x-forwarded-host"], `127.0.0.1:${gatewayPort}`);
});

test("HTTP lifecycle does not enter the certificate/OpenSSL path", async () => {
  const source = await readFile(new URL("../tooling/e2e/lifecycle.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(state\.transport === "https"\) \{[\s\S]*capture\("logs\/cert\.log", "openssl"[\s\S]*\}/u);
  assert.match(source, /\.\.\.\(state\.transport === "https" \? \{ E2E_CERT_PATH: cert, E2E_KEY_PATH: key \} : \{\}\)/u);
  assert.doesNotMatch(source, /capture\("logs\/cert\.log", "openssl"\)\s*;\s*if \(state\.transport === "http"\)/u);
});
