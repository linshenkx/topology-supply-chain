import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { DatabaseClientError } from "../dist/infrastructure/database.js";
import { ApprovalEffectRegistry, ApprovalPolicyRegistry, consumeStepUpClaim } from "../dist/platform/approvals.js";
import { canonicalRequestDigest, executeCommand, requireWriterFence } from "../dist/platform/commands.js";
import { createPlatformFileEntityAuthorizer, FileAuthorizationRegistry, registerDomainManifests } from "../dist/platform/registrations.js";
import { deriveSessionToken, requireCsrf, requireSameOrigin } from "../dist/platform/security.js";
import { buildRuntimeApp } from "../dist/runtime.js";

const IDEMPOTENCY_KEY = "platform-command-key-0001";

test("deterministic session tokens are isolated by authenticated subject", () => {
  const key = "scope-a-session-signing-key-00000001";
  const firstSubject = "a".repeat(64);
  const secondSubject = "b".repeat(64);

  assert.equal(
    deriveSessionToken(key, "auth.verify", firstSubject, IDEMPOTENCY_KEY),
    deriveSessionToken(key, "auth.verify", firstSubject, IDEMPOTENCY_KEY),
  );
  assert.notEqual(
    deriveSessionToken(key, "auth.verify", firstSubject, IDEMPOTENCY_KEY),
    deriveSessionToken(key, "auth.verify", secondSubject, IDEMPOTENCY_KEY),
  );
});

test("independent domain manifests receive the frozen R2/R3 platform ports", async () => {
  const registrations = [];
  const context = {
    app: {}, database: {}, unitOfWork: async (run) => run({}), executeCommand, requireWriterFence,
    authenticate: async () => ({ roles: [] }), authorize: () => false,
    audit: async () => undefined, enqueueOutbox: async () => undefined,
    approvalPolicy: new ApprovalPolicyRegistry(),
    approvalEffects: new ApprovalEffectRegistry(), fileAuthorizations: new FileAuthorizationRegistry(),
  };
  await registerDomainManifests(context, [
    { id: "r2.inventory", register(received) { registrations.push(["r2", received]); } },
    { id: "r3.finance", register(received) { registrations.push(["r3", received]); } },
  ]);
  assert.deepEqual(registrations.map(([id]) => id), ["r2", "r3"]);
  assert.equal(registrations[0][1], registrations[1][1]);
  context.approvalPolicy.register("r2.object", { evaluate: async () => ({ allowed: true, reasonCode: "R2_ALLOWED" }) });
  assert.deepEqual(await context.approvalPolicy.evaluate({ objectType: "r2.object" }), { allowed: true, reasonCode: "R2_ALLOWED" });
  assert.deepEqual(await context.approvalPolicy.evaluate({ objectType: "r3.object" }), { allowed: false, reasonCode: "NO_DOMAIN_POLICY" });
  for (const port of ["database", "unitOfWork", "executeCommand", "requireWriterFence", "authenticate", "authorize", "audit", "enqueueOutbox", "approvalPolicy", "approvalEffects", "fileAuthorizations"]) {
    assert.ok(port in registrations[0][1], `missing frozen port ${port}`);
  }
  await assert.rejects(registerDomainManifests(context, [
    { id: "r2.duplicate", register() {} }, { id: "r2.duplicate", register() {} },
  ]), /rejected/u);
});

test("R2 and R3 writer resources can be fenced independently without a global switch", async () => {
  const fences = new Map([
    ["r2.commands", { owner: "r2-v1", enabled: 1, generation: 2 }],
    ["r3.commands", { owner: "r3-v1", enabled: 0, generation: 2 }],
  ]);
  const transaction = { async query(_sql, parameters) { const row = fences.get(parameters[0]); return row ? [row] : []; } };
  await requireWriterFence(transaction, { resource: "r2.commands", owner: "r2-v1", generation: 2 });
  await assert.rejects(requireWriterFence(transaction, { resource: "r3.commands", owner: "r3-v1", generation: 2 }), { code: "WRITER_FENCE_REJECTED" });
  fences.get("r2.commands").enabled = 0;
  fences.get("r3.commands").enabled = 1;
  await assert.rejects(requireWriterFence(transaction, { resource: "r2.commands", owner: "r2-v1", generation: 2 }), { code: "WRITER_FENCE_REJECTED" });
  await requireWriterFence(transaction, { resource: "r3.commands", owner: "r3-v1", generation: 2 });
});

test("built-in file authorization follows entity relations and keeps legacy files owner-only", async () => {
  const database = { async query(sql, parameters) {
    if (sql.includes("FROM file_objects")) return parameters[0] === "77" && parameters[1] === 9 ? [{ allowed: 1 }] : [];
    if (!sql.includes("FROM delivery_batches")) return [];
    return parameters[0] === "12" && (parameters[1] === 1 || parameters[2] === 4 || parameters[3] === 8) ? [{ allowed: 1 }] : [];
  } };
  const authorize = createPlatformFileEntityAuthorizer(database);
  const access = { roles: ["factory"], factoryId: 4, supplierId: null, userId: 9 };
  assert.equal(await authorize({ access, entityType: "delivery_batch", entityId: "12", operation: "write" }), true);
  assert.equal(await authorize({ access: { ...access, factoryId: 5 }, entityType: "delivery_batch", entityId: "12", operation: "read" }), false);
  assert.equal(await authorize({ access, entityType: "unknown", entityId: "12", operation: "read" }), false);
  assert.equal(await authorize({ access: { ...access, roles: ["supply_chain"] }, entityType: "import_upload", entityId: "9", operation: "write" }), true);
  assert.equal(await authorize({ access: { ...access, roles: ["supply_chain"] }, entityType: "import_upload", entityId: "10", operation: "write" }), false);
  assert.equal(await authorize({ access: { ...access, roles: ["company_qc"] }, entityType: "import_upload", entityId: "9", operation: "write" }), false);
  assert.equal(await authorize({ access, entityType: "import_upload", entityId: "9", operation: "write" }), false);
  assert.equal(await authorize({ access, entityType: "legacy_file", entityId: "77", operation: "read" }), true);
  assert.equal(await authorize({ access: { ...access, userId: 10 }, entityType: "legacy_file", entityId: "77", operation: "read" }), false);
});

function request(headers = {}) {
  return { headers: { "idempotency-key": IDEMPOTENCY_KEY, ...headers } };
}

function fakeCommandDatabase({ fence = true, commitUnknown = false } = {}) {
  const state = { row: undefined, runCalls: 0 };
  const transaction = {
    async execute(sql, params = []) {
      if (sql.includes("INSERT IGNORE INTO command_idempotency")) {
        if (state.row !== undefined) return { affectedRows: 0 };
        state.row = {
          requestDigest: params[3],
          responseJson: null,
          responseStatus: null,
          status: "pending",
        };
        return { affectedRows: 1 };
      }
      if (sql.includes("UPDATE command_idempotency")) {
        state.row.status = "completed";
        state.row.responseStatus = params[0];
        state.row.responseJson = params[1];
        return { affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    async query(sql) {
      if (sql.includes("FROM writer_fences")) {
        return fence ? [{ owner: "fastify-v1", enabled: 1, generation: 2 }] : [];
      }
      if (sql.includes("FROM command_idempotency")) return [state.row];
      throw new Error("unexpected query");
    },
  };
  return {
    state,
    async transaction(callback) {
      if (commitUnknown) {
        throw new DatabaseClientError(
          "DATABASE_TRANSACTION_OUTCOME_UNKNOWN",
          "driver secret",
        );
      }
      return callback(transaction);
    },
  };
}

test("canonical command digests are stable over object key ordering", () => {
  const left = canonicalRequestDigest("users.unlock", {
    action: "unlock",
    userId: 42,
    nested: { b: 2, a: 1 },
  });
  const right = canonicalRequestDigest("users.unlock", {
    nested: { a: 1, b: 2 },
    userId: 42,
    action: "unlock",
  });
  assert.equal(left, right);
  assert.match(left, /^[a-f\d]{64}$/u);
  assert.notEqual(
    left,
    canonicalRequestDigest("users.unlock", { action: "unlock", userId: 43 }),
  );
});

test("command completion replays once and rejects key reuse with another digest", async () => {
  const database = fakeCommandDatabase();
  const options = {
    actorScope: "user:7",
    command: "users.unlock",
    database,
    payload: { action: "unlock", userId: 42 },
    request: request(),
    async run() {
      database.state.runCalls += 1;
      return { success: true, userId: 42 };
    },
  };
  const first = await executeCommand(options);
  const replay = await executeCommand(options);
  assert.equal(first.body.command.replayed, false);
  assert.equal(replay.body.command.replayed, true);
  assert.deepEqual(replay.body.result, first.body.result);
  assert.equal(database.state.runCalls, 1);

  await assert.rejects(
    executeCommand({ ...options, payload: { action: "unlock", userId: 43 } }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED" && error.statusCode === 409,
  );
});

test("writer fence and unknown commit outcomes fail closed with stable codes", async () => {
  for (const [database, code] of [
    [fakeCommandDatabase({ fence: false }), "WRITER_FENCE_REJECTED"],
    [fakeCommandDatabase({ commitUnknown: true }), "COMMAND_OUTCOME_UNKNOWN"],
  ]) {
    await assert.rejects(
      executeCommand({
        actorScope: "user:7",
        command: "notifications.mark-read",
        database,
        payload: { id: 1 },
        request: request(),
        async run() { return { success: true }; },
      }),
      (error) => error.code === code,
    );
  }
});

test("origin and CSRF guards reject missing, cross-origin, and duplicate tokens", async (t) => {
  const app = await buildApp({ logger: false });
  app.post("/guard", async (incoming) => {
    requireSameOrigin(incoming);
    requireCsrf(incoming);
    return { ok: true };
  });
  t.after(() => app.close());

  const token = "ab".repeat(32);
  const accepted = await app.inject({
    method: "POST",
    url: "/guard",
    headers: {
      host: "scm.topologygz.com",
      origin: "https://scm.topologygz.com",
      "x-forwarded-proto": "https",
      cookie: `topology_csrf=${token}`,
      "x-csrf-token": token,
    },
  });
  assert.equal(accepted.statusCode, 200);

  const cases = [
    { headers: { host: "scm.topologygz.com", "x-forwarded-proto": "https" }, code: "ORIGIN_REJECTED" },
    { headers: { host: "scm.topologygz.com", origin: "https://evil.example", "x-forwarded-proto": "https" }, code: "ORIGIN_REJECTED" },
    { headers: { host: "scm.topologygz.com", origin: "https://scm.topologygz.com", "x-forwarded-proto": "https" }, code: "CSRF_REJECTED" },
    { headers: { host: "scm.topologygz.com", origin: "https://scm.topologygz.com", "x-forwarded-proto": "https", cookie: `topology_csrf=${token}; topology_csrf=${token}`, "x-csrf-token": token }, code: "CSRF_REJECTED" },
  ];
  for (const fixture of cases) {
    const response = await app.inject({ method: "POST", url: "/guard", headers: fixture.headers });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, fixture.code);
  }
});

test("approval effect registrations are isolated and step-up claims bind every dimension", async () => {
  const registry = new ApprovalEffectRegistry();
  registry.register({ effectType: "r2.purchase", async execute() { return "r2"; } });
  registry.register({ effectType: "r3.finance", async execute() { return "r3"; } });
  assert.deepEqual(registry.registeredTypes(), ["r2.purchase", "r3.finance"]);
  assert.throws(
    () => registry.register({ effectType: "r2.purchase", async execute() {} }),
    /registration rejected/u,
  );

  const executions = [];
  await consumeStepUpClaim(
    {
      async query() { throw new Error("unexpected query"); },
      async execute(sql, params) { executions.push({ sql, params }); return { affectedRows: 1 }; },
    },
    {
      challengeNo: "HR-1",
      userId: 7,
      sessionId: 8,
      action: "approve",
      objectType: "approval",
      objectId: "9",
      objectVersion: 3,
      requestDigest: "ab".repeat(32),
    },
  );
  assert.match(executions[0].sql, /session_id = \?.*action = \?.*object_type = \?.*object_version = \?.*request_digest = \?/su);
  assert.deepEqual(executions[0].params.slice(0, -1), ["HR-1", 7, 8, "approve", "approval", "9", 3, "ab".repeat(32)]);
  assert.match(executions[0].params.at(-1), /^\d{4}-\d{2}-\d{2}T/u);
});

test("OpenAPI freezes all ten externally callable platform mutations", async (t) => {
  const app = await buildRuntimeApp({
    environment: { APP_ENV: "development", DEPLOY_TARGET: "local", NODE_ENV: "development" },
    logger: false,
  });
  t.after(() => app.close());
  await app.ready();
  const paths = app.swagger().paths;
  for (const [path, method] of [
    ["/api/v1/auth/login", "post"],
    ["/api/v1/auth/verify", "post"],
    ["/api/v1/auth/logout", "post"],
    ["/api/v1/auth/step-up/request", "post"],
    ["/api/v1/auth/step-up/verify", "post"],
    ["/api/v1/users", "post"],
    ["/api/v1/users", "delete"],
    ["/api/v1/users", "patch"],
    ["/api/v1/files", "post"],
    ["/api/v1/notifications/read", "post"],
  ]) {
    const operation = paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path}`);
    assert.ok(operation.responses[503], `${method.toUpperCase()} ${path} must document unknown/unavailable outcomes`);
    assert.ok(operation.responses["5XX"], `${method.toUpperCase()} ${path} must document sanitized 5xx outcomes`);
  }
});

test("all twelve legacy handlers are explicit non-writing retirements", async () => {
  const root = new URL("../../..", import.meta.url);
  const routes = [
    "apps/web/app/api/auth/login/route.ts",
    "apps/web/app/api/auth/verify/route.ts",
    "apps/web/app/api/auth/logout/route.ts",
    "apps/web/app/api/auth/step-up/request/route.ts",
    "apps/web/app/api/auth/step-up/verify/route.ts",
    "apps/web/app/api/users/route.ts",
    "apps/web/app/api/files/route.ts",
    "apps/web/app/api/notifications/route.ts",
    "apps/web/app/api/jobs/reminders/route.ts",
    "apps/web/app/api/jobs/email/route.ts",
  ];
  for (const route of routes) {
    const content = await readFile(new URL(route, root), "utf8");
    assert.match(content, /retiredPlatformRoute/u);
    assert.doesNotMatch(content, /getDb|drizzle|oss|sendVerificationSms|fetch\(/iu);
  }
  const users = await readFile(new URL("apps/web/app/api/users/route.ts", root), "utf8");
  assert.match(users, /POST/u);
  assert.match(users, /DELETE/u);
  assert.match(users, /PATCH/u);
});
