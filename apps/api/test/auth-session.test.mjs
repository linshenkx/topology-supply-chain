import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerAuthModule } from "../dist/modules/auth/index.js";

const SESSION_TOKEN = "ab".repeat(32);
const NOW = new Date("2026-08-11T03:04:05.678Z");
const PRODUCTION = {
  appEnv: "production",
  deployTarget: "aliyun",
  nodeEnv: "production",
};
const DEVELOPMENT = {
  appEnv: "development",
  deployTarget: "local",
  nodeEnv: "development",
};

const activeSession = {
  sessionId: 73,
  userId: 42,
  email: "buyer@example.com",
  name: "Buyer",
  primaryRole: "supply_chain",
  factoryId: null,
  supplierId: 17,
  organizationName: "Topology",
  accountStatus: "active",
};

class FakeQueryExecutor {
  constructor({
    sessionRows = [],
    roleRows = [],
    revalidationRows,
    affectedRows = 1,
    executeError,
    queryError,
  } = {}) {
    this.sessionRows = sessionRows;
    this.roleRows = roleRows;
    this.revalidationRows = revalidationRows;
    this.affectedRows = affectedRows;
    this.executeError = executeError;
    this.queryError = queryError;
    this.queries = [];
    this.executions = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params: [...params] });
    if (this.queryError) throw this.queryError;
    if (/FROM auth_sessions AS sessions/u.test(sql)) {
      if (/sessions\.id = \?/u.test(sql) && this.revalidationRows !== undefined) {
        return this.revalidationRows;
      }
      return this.sessionRows;
    }
    return this.roleRows;
  }

  async execute(sql, params = []) {
    this.executions.push({ sql, params: [...params] });
    if (this.executeError) throw this.executeError;
    return { affectedRows: this.affectedRows };
  }
}

async function usingAuthApp(options, run) {
  const app = await buildApp({ logger: false });
  await registerAuthModule(app, { now: () => NOW, ...options });

  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function sessionRequest(overrides = {}) {
  return {
    method: "GET",
    url: "/api/v1/session",
    headers: {
      host: "scm.topologygz.com",
      cookie: `topology_session=${SESSION_TOKEN}`,
    },
    ...overrides,
  };
}

test("missing, malformed, and duplicate session cookies return 401 without a database lookup", async () => {
  const database = new FakeQueryExecutor();

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      for (const cookie of [
        undefined,
        "topology_session=short",
        `topology_session=${SESSION_TOKEN}; topology_session=${SESSION_TOKEN}`,
        `topology_session=${"z".repeat(64)}`,
      ]) {
        const headers = { host: "scm.topologygz.com" };
        if (cookie !== undefined) headers.cookie = cookie;
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/session",
          headers,
        });

        assert.equal(response.statusCode, 401);
        assert.deepEqual(Object.keys(response.json()).sort(), [
          "code",
          "message",
          "requestId",
        ]);
      }
    },
  );

  assert.equal(database.queries.length, 0);
  assert.equal(database.executions.length, 0);
});

test("an unknown or expired session returns 401 and never trusts identity headers", async () => {
  const database = new FakeQueryExecutor();

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(
        sessionRequest({
          headers: {
            host: "scm.topologygz.com",
            cookie: `topology_session=${SESSION_TOKEN}`,
            "oai-authenticated-user-email": "admin@attacker.example",
            "oai-authenticated-user-full-name": "Forged Admin",
          },
        }),
      );

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHORIZED");
      assert.doesNotMatch(response.body, /attacker|Forged Admin|topology_session/iu);
    },
  );

  assert.equal(database.queries.length, 1);
  assert.equal(database.executions.length, 0);
});

test("a valid session for a non-active account returns 403", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [{ ...activeSession, accountStatus: "locked" }],
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, "FORBIDDEN");
    },
  );

  assert.equal(database.queries.length, 1);
  assert.equal(database.executions.length, 0);
});

test("the session response preserves the legacy contract and de-duplicates effective roles", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    roleRows: [
      { roleCode: "finance" },
      { roleCode: "supply_chain" },
      { roleCode: "finance" },
    ],
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        user: {
          id: 42,
          email: "buyer@example.com",
          name: "Buyer",
          roles: ["supply_chain", "finance"],
          factoryId: null,
          supplierId: 17,
        },
        security: {
          passwordAttemptsBeforeLock: 5,
          trustedDeviceDays: 90,
          highRiskRequiresSms: true,
          separationOfDuties: true,
        },
        localPreview: false,
      });
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers.pragma, "no-cache");
      assert.equal(response.headers.vary, "Cookie");
    },
  );

  assert.equal(database.queries.length, 2);
  const roleQuery = database.queries[1];
  assert.match(roleQuery.sql, /status = 'active'/u);
  assert.match(roleQuery.sql, /effective_from <= \?/u);
  assert.match(roleQuery.sql, /effective_to IS NULL OR effective_to >= \?/u);
  assert.deepEqual(roleQuery.params, [42, "2026-08-11", "2026-08-11"]);
});

test("session and heartbeat SQL use parameters and only the SHA-256 token hash", async () => {
  const database = new FakeQueryExecutor({ sessionRows: [activeSession] });
  const expectedHash = createHash("sha256")
    .update(SESSION_TOKEN, "utf8")
    .digest("hex");

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());
      assert.equal(response.statusCode, 200);
    },
  );

  const sessionQuery = database.queries[0];
  assert.match(sessionQuery.sql, /sessions\.token_hash = \?/u);
  assert.match(sessionQuery.sql, /sessions\.revoked_at IS NULL/u);
  assert.match(sessionQuery.sql, /sessions\.expires_at > \?/u);
  assert.doesNotMatch(sessionQuery.sql, new RegExp(SESSION_TOKEN, "u"));
  assert.doesNotMatch(sessionQuery.sql, new RegExp(expectedHash, "u"));
  assert.deepEqual(sessionQuery.params, [expectedHash, NOW.toISOString()]);

  const heartbeat = database.executions[0];
  assert.match(heartbeat.sql, /UPDATE auth_sessions/u);
  assert.match(heartbeat.sql, /INNER JOIN users AS users/u);
  assert.match(heartbeat.sql, /last_seen_at = CURRENT_TIMESTAMP\(3\)/u);
  assert.match(heartbeat.sql, /token_hash = \?/u);
  assert.match(heartbeat.sql, /revoked_at IS NULL/u);
  assert.match(heartbeat.sql, /expires_at > \?/u);
  assert.match(heartbeat.sql, /users\.account_status = 'active'/u);
  assert.doesNotMatch(heartbeat.sql, new RegExp(SESSION_TOKEN, "u"));
  assert.deepEqual(heartbeat.params, [
    73,
    expectedHash,
    NOW.toISOString(),
  ]);
});

test("an unchanged last-seen timestamp is revalidated instead of rejecting a valid session", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    revalidationRows: [{ sessionId: 73, accountStatus: "active" }],
    affectedRows: 0,
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());
      assert.equal(response.statusCode, 200);
    },
  );

  assert.equal(database.queries.length, 3);
  const revalidation = database.queries[2];
  assert.match(revalidation.sql, /sessions\.id = \?/u);
  assert.match(revalidation.sql, /sessions\.revoked_at IS NULL/u);
  assert.match(revalidation.sql, /sessions\.expires_at > \?/u);
});

test("a concurrent revoke or expiry during last-seen persistence returns 401", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    revalidationRows: [],
    affectedRows: 0,
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHORIZED");
    },
  );
});

test("an account locked after the initial read is rejected during heartbeat revalidation", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    revalidationRows: [{ sessionId: 73, accountStatus: "locked" }],
    affectedRows: 0,
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().code, "FORBIDDEN");
    },
  );
});

test("last-seen persistence failure fails closed with a sanitized 503", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    executeError: new Error("mysql://root:secret@database/session-token"),
  });

  await usingAuthApp(
    { database, environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /mysql|root|secret|session-token/iu);
    },
  );
});

test("a missing database outside local preview returns a sanitized 503", async () => {
  await usingAuthApp(
    { environment: PRODUCTION },
    async (app) => {
      const response = await app.inject(sessionRequest());

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /DATABASE_URL|database/iu);
    },
  );
});

test("non-production loopback receives preview access before any database dependency", async () => {
  await usingAuthApp(
    { environment: DEVELOPMENT },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { host: "127.0.0.1:3001" },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().localPreview, true);
      assert.equal(response.json().user.id, 0);
      assert.deepEqual(response.json().user.roles, [
        "admin",
        "supply_chain",
        "finance",
        "company_qc",
      ]);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers.pragma, "no-cache");
      assert.equal(response.headers.vary, "Cookie");
    },
  );
});

test("a valid local cookie authenticates the real user instead of escalating to preview", async () => {
  const database = new FakeQueryExecutor({
    sessionRows: [activeSession],
    roleRows: [{ roleCode: "finance" }],
  });

  await usingAuthApp(
    { database, environment: DEVELOPMENT },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: {
          host: "127.0.0.1:3001",
          cookie: `topology_session=${SESSION_TOKEN}`,
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().localPreview, false);
      assert.equal(response.json().user.id, activeSession.userId);
    },
  );
  assert.equal(database.queries.length, 2);
});

test("a malformed local session cookie cannot fall back to preview", async () => {
  const database = new FakeQueryExecutor();

  await usingAuthApp(
    { database, environment: DEVELOPMENT },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: {
          host: "localhost:3001",
          cookie: "topology_session=malformed",
        },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHORIZED");
      assert.equal(response.json().localPreview, undefined);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers.pragma, "no-cache");
      assert.equal(response.headers.vary, "Cookie");
    },
  );
  assert.equal(database.queries.length, 0);
});

test("an unknown local session cookie cannot fall back to preview", async () => {
  const database = new FakeQueryExecutor();

  await usingAuthApp(
    { database, environment: DEVELOPMENT },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: {
          host: "localhost:3001",
          cookie: `topology_session=${SESSION_TOKEN}`,
        },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHORIZED");
      assert.equal(response.json().localPreview, undefined);
    },
  );
  assert.equal(database.queries.length, 1);
});

test("a remote client cannot forge localhost Host to receive preview access", async () => {
  const database = new FakeQueryExecutor();

  await usingAuthApp(
    { database, environment: DEVELOPMENT },
    async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { host: "localhost:3001" },
        remoteAddress: "203.0.113.19",
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "UNAUTHORIZED");
      assert.equal(response.json().localPreview, undefined);
    },
  );
  assert.equal(database.queries.length, 0);
});

test("every production marker defeats a forged localhost Host", async () => {
  for (const environment of [
    { ...DEVELOPMENT, appEnv: "production" },
    { ...DEVELOPMENT, deployTarget: "aliyun" },
    { ...DEVELOPMENT, nodeEnv: "production" },
  ]) {
    const database = new FakeQueryExecutor();
    await usingAuthApp({ database, environment }, async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: {
          host: "localhost:3001",
          cookie: `topology_session=${SESSION_TOKEN}`,
        },
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().localPreview, undefined);
    });
    assert.equal(database.queries.length, 1);
  }
});

test("OpenAPI exposes the contract-backed session endpoint", async () => {
  await usingAuthApp(
    { environment: DEVELOPMENT },
    async (app) => {
      await app.ready();
      const openapi = app.swagger();

      assert.ok(openapi.paths?.["/api/v1/session"]?.get);
      assert.ok(openapi.components?.schemas?.Session);
    },
  );
});
