import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const routeUrl = new URL(
  "../../../apps/web/app/api/v1/[...path]/route.ts",
  import.meta.url,
);
const repositoryRoot = new URL("../../..", import.meta.url);
const securityUrl = new URL("../src/platform/security.ts", import.meta.url);
const fastifyUrl = new URL("../node_modules/fastify/fastify.js", import.meta.url);

function evaluate(source) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env },
    },
  );
}

test("development bridge supports the frozen write allowlist and refuses production", () => {
  const result = evaluate(`
    process.env.APP_ENV = "production";
    process.env.DEPLOY_TARGET = "aliyun";
    process.env.NODE_ENV = "production";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("must not reach upstream");
    };
    const route = await import(${JSON.stringify(routeUrl.href)});
    const response = await route.GET(new Request(
      "http://127.0.0.1:3000/api/v1/users"
    ));
    process.stdout.write(JSON.stringify({
      cacheControl: response.headers.get("cache-control"),
      fetchCalls,
      hasPost: typeof route.POST === "function",
      pragma: response.headers.get("pragma"),
      status: response.status,
      vary: response.headers.get("vary")
    }));
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cacheControl: "private, no-store",
    fetchCalls: 0,
    hasPost: true,
    pragma: "no-cache",
    status: 404,
    vary: "Cookie",
  });
});

test("Stage 4 development bridge uses a fixed allowlist and forwards only safe metadata", () => {
  const result = evaluate(`
    process.env.APP_ENV = "development";
    process.env.DEPLOY_TARGET = "local";
    process.env.NODE_ENV = "development";
    const token = "b".repeat(64);
    const captures = [];
    globalThis.fetch = async (url, options) => {
      captures.push({
        authorization: options.headers.get("authorization"),
        cookie: options.headers.get("cookie"),
        forgedIdentity: options.headers.get("oai-authenticated-user-email"),
        method: options.method,
        requestId: options.headers.get("x-request-id"),
        url: String(url)
      });
      return new Response(JSON.stringify({ logs: [], total: 0 }), {
        status: 200,
        headers: {
          "content-disposition": "attachment; filename=logs.xlsx",
          "content-type": "application/json",
          "set-cookie": "session=must-not-leak",
          "x-request-id": "stage4-bridge-check"
        }
      });
    };
    const route = await import(${JSON.stringify(routeUrl.href)});
    const response = await route.GET(new Request(
      "http://localhost:3000/api/v1/audit-logs?page=2&export=xlsx",
      { headers: {
        authorization: "Bearer must-not-forward",
        cookie: "theme=dark; topology_session=" + token,
        "oai-authenticated-user-email": "forged@example.com",
        "x-request-id": "stage4-bridge-check"
      } }
    ));
    const duplicateCookie = await route.GET(new Request(
      "http://localhost:3000/api/v1/users",
      { headers: { cookie: "topology_session=" + token + "; topology_session=" + token } }
    ));
    const callsBeforeRejected = captures.length;
    const rejected = await route.GET(new Request(
      "http://localhost:3000/api/v1/auth/login?next=http://evil.test"
    ));
    process.stdout.write(JSON.stringify({
      cacheControl: response.headers.get("cache-control"),
      captures,
      callsBeforeRejected,
      contentDisposition: response.headers.get("content-disposition"),
      duplicateCookieStatus: duplicateCookie.status,
      payload: await response.json(),
      rejectedStatus: rejected.status,
      responseSetCookie: response.headers.get("set-cookie"),
      totalFetchCalls: captures.length,
      vary: response.headers.get("vary")
    }));
  `);

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.captures, [
    {
      authorization: null,
      cookie: `topology_session=${"b".repeat(64)}`,
      forgedIdentity: null,
      method: "GET",
      requestId: "stage4-bridge-check",
      url: "http://127.0.0.1:3001/api/v1/audit-logs?page=2&export=xlsx",
    },
    {
      authorization: null,
      cookie: null,
      forgedIdentity: null,
      method: "GET",
      requestId: null,
      url: "http://127.0.0.1:3001/api/v1/users",
    },
  ]);
  assert.equal(body.cacheControl, "private, no-store");
  assert.equal(body.callsBeforeRejected, 2);
  assert.equal(body.contentDisposition, "attachment; filename=logs.xlsx");
  assert.equal(body.duplicateCookieStatus, 200);
  assert.deepEqual(body.payload, { logs: [], total: 0 });
  assert.equal(body.rejectedStatus, 404);
  assert.equal(body.responseSetCookie, null);
  assert.equal(body.totalFetchCalls, 2);
  assert.equal(body.vary, "Cookie");
});

test("development write bridge forwards only command security metadata and body", () => {
  const result = evaluate(`
    process.env.APP_ENV = "development"; process.env.DEPLOY_TARGET = "local"; process.env.NODE_ENV = "development";
    let capture;
    globalThis.fetch = async (url, options) => {
      capture = { url:String(url), method:options.method, body:Buffer.from(options.body).toString("utf8"),
        cookie:options.headers.get("cookie"), csrf:options.headers.get("x-csrf-token"),
        idempotency:options.headers.get("idempotency-key"), digest:options.headers.get("x-request-digest"),
        identity:options.headers.get("oai-authenticated-user-email"), origin:options.headers.get("origin"),
        forwardedHost:options.headers.get("x-forwarded-host"), forwardedProto:options.headers.get("x-forwarded-proto") };
      return new Response(JSON.stringify({ command:{}, result:{ success:true } }), { status:200, headers:{"content-type":"application/json"} });
    };
    const route = await import(${JSON.stringify(routeUrl.href)});
    const token="a".repeat(64), csrf="b".repeat(64), digest="c".repeat(64);
    const response = await route.POST(new Request("http://localhost:3000/api/v1/users", { method:"POST",
      headers:{ cookie:"topology_session="+token+"; topology_csrf="+csrf, "x-csrf-token":csrf,
        "idempotency-key":"bridge-command-key-0001", "x-request-digest":digest,
        origin:"http://localhost:3000", "content-type":"application/json", "oai-authenticated-user-email":"forged@example.com" },
      body:JSON.stringify({ userId:7, action:"unlock" }) }));
    process.stdout.write(JSON.stringify({ capture, status:response.status }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, 200);
  assert.deepEqual(body.capture, {
    url: "http://127.0.0.1:3001/api/v1/users", method: "POST",
    body: JSON.stringify({ userId: 7, action: "unlock" }),
    cookie: `topology_session=${"a".repeat(64)}; topology_csrf=${"b".repeat(64)}`,
    csrf: "b".repeat(64), idempotency: "bridge-command-key-0001", digest: "c".repeat(64), identity: null,
    origin: "http://localhost:3000", forwardedHost: "localhost:3000", forwardedProto: "http",
  });
});

test("real Next bridge reaches a real Fastify guarded write and rejects an external origin", () => {
  const result = evaluate(`
    process.env.APP_ENV = "development"; process.env.DEPLOY_TARGET = "local"; process.env.NODE_ENV = "development";
    const fastify = (await import(${JSON.stringify(fastifyUrl.href)})).default({ logger:false, trustProxy:true });
    const { requireSameOrigin, requireCsrf } = await import(${JSON.stringify(securityUrl.href)});
    let capture;
    fastify.post("/api/v1/users", async request => {
      requireSameOrigin(request); requireCsrf(request);
      capture = { cookie:request.headers.cookie, csrf:request.headers["x-csrf-token"],
        idempotency:request.headers["idempotency-key"], requestId:request.headers["x-request-id"],
        origin:request.headers.origin, host:request.headers["x-forwarded-host"], proto:request.headers["x-forwarded-proto"],
        identity:request.headers["oai-authenticated-user-email"] ?? null };
      return { command:{ command:"users.unlock", idempotencyKey:request.headers["idempotency-key"], requestDigest:"c".repeat(64), replayed:false }, result:{ success:true } };
    });
    await fastify.listen({ host:"127.0.0.1", port:3001 });
    try {
      const route = await import(${JSON.stringify(routeUrl.href)});
      const token="a".repeat(64), csrf="b".repeat(64);
      const headers = { origin:"http://localhost:3000", cookie:"topology_session="+token+"; topology_csrf="+csrf,
        "x-csrf-token":csrf, "idempotency-key":"bridge-real-write-0001", "x-request-id":"bridge-real-request",
        "x-request-digest":"c".repeat(64), "content-type":"application/json", "oai-authenticated-user-email":"forged@example.com" };
      const ok = await route.POST(new Request("http://localhost:3000/api/v1/users", { method:"POST", headers, body:JSON.stringify({ userId:7 }) }));
      const evil = await route.POST(new Request("http://localhost:3000/api/v1/users", { method:"POST", headers:{ ...headers, origin:"https://evil.example" }, body:JSON.stringify({ userId:7 }) }));
      process.stdout.write(JSON.stringify({ ok:ok.status, evil:evil.status, capture }));
    } finally { await fastify.close(); }
  `);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, 200);
  assert.equal(body.evil, 404);
  assert.deepEqual(body.capture, {
    cookie: `topology_session=${"a".repeat(64)}; topology_csrf=${"b".repeat(64)}`,
    csrf: "b".repeat(64), idempotency: "bridge-real-write-0001", requestId: "bridge-real-request",
    origin: "http://localhost:3000", host: "localhost:3000", proto: "http", identity: null,
  });
});
