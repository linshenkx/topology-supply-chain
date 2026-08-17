import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerUsersModule } from "../dist/modules/users/index.js";

const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");
const csrf = "ab".repeat(32);
const adminContext = {
  sessionId: 77,
  userId: 9,
  email: "admin@example.com",
  name: "Admin",
  roles: ["admin"],
  factoryId: null,
  supplierId: null,
  organizationName: "Topology",
  localPreview: false,
};

function writeHeaders(idempotencyKey) {
  return {
    host: "localhost",
    origin: "http://localhost",
    "x-forwarded-proto": "http",
    cookie: `topology_csrf=${csrf}`,
    "x-csrf-token": csrf,
    "idempotency-key": idempotencyKey,
  };
}

const validCreatePayload = {
  email: "new-user@example.com",
  initialPassword: "InitialPass!234",
  mobile: "13800138009",
  name: "New User",
  organizationName: "Topology",
  roleCode: "supply_chain",
};

function userRow(id, overrides = {}) {
  return {
    id,
    email: `user-${id}@example.com`,
    mobile: "13800138000",
    name: `User ${id}`,
    primaryRole: "finance",
    factoryId: null,
    supplierId: null,
    organizationName: "Topology",
    accountStatus: "active",
    createdAt: "2026-01-01 00:00:00.000",
    updatedAt: "2026-08-01 00:00:00.000",
    ...overrides,
  };
}

function roleRow(id, userId, overrides = {}) {
  return {
    id,
    userId,
    roleCode: "company_qc",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    status: "active",
    requestedBy: 9,
    reviewedBy: 10,
    reviewedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function fakeDatabase({ roles = [], users = [], executeError } = {}) {
  const executions = [];
  const queries = [];
  return {
    executions,
    queries,
    async execute(sql, params = []) {
      executions.push({ sql, params });
      if (executeError !== undefined) throw executeError;
      return { affectedRows: 1 };
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM users")) return users;
      if (sql.includes("FROM user_roles")) {
        return roles.filter((row) => params.includes(row.userId));
      }
      throw new Error("unexpected SQL");
    },
  };
}

async function createUsersApp({ context, database, audit } = {}) {
  const app = await buildApp({ logger: false });
  await registerUsersModule(app, {
    authenticate: async () => context ?? adminContext,
    database,
    audit: audit ?? (() => undefined),
    now: fixedNow,
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("admin reads bounded users, masks mobiles, expires roles, and audits the sensitive view", async (t) => {
  const database = fakeDatabase({
    users: [
      userRow(1),
      userRow(2, {
        mobile: "short",
        primaryRole: "factory",
        factoryId: 7,
      }),
    ],
    roles: [
      roleRow(10, 1, { reviewedBy: null, reviewedAt: null }),
      roleRow(11, 1, { roleCode: "finance" }),
      roleRow(12, 2, { roleCode: "supplier_qc", status: "expired" }),
    ],
  });
  const audits = [];
  const app = await createUsersApp({
    database,
    audit: async (event) => audits.push(event),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/users" });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.equal(body.users[0].mobile, "138****8000");
  assert.equal(body.users[0].factoryId, null);
  assert.equal(body.users[0].supplierId, null);
  assert.equal(body.users[1].mobile, "");
  assert.deepEqual(body.users[0].roles, ["finance", "company_qc"]);
  assert.deepEqual(body.users[1].roles, ["factory"]);
  assert.equal(body.users[0].roleAssignments.length, 2);
  assert.equal(body.users[0].roleAssignments[0].effectiveTo, null);
  assert.equal(body.users[0].roleAssignments[0].reviewedBy, null);
  assert.equal(body.users[0].roleAssignments[0].reviewedAt, null);
  assert.deepEqual(database.executions[0].params, [
    "expired",
    "active",
    "2026-08-11",
  ]);
  assert.match(database.executions[0].sql, /effective_to < \?/u);
  assert.match(
    database.queries[0].sql,
    /ORDER BY name ASC, id ASC\s+LIMIT 1001$/u,
  );
  assert.match(
    database.queries[1].sql,
    /WHERE user_id IN \(\?, \?\)\s+ORDER BY user_id ASC, id ASC\s+LIMIT 5001$/u,
  );
  assert.deepEqual(database.queries[1].params, [1, 2]);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    {
      action: audits[0].action,
      entityId: audits[0].entityId,
      entityType: audits[0].entityType,
      module: audits[0].module,
      sensitiveView: audits[0].sensitiveView,
      userId: audits[0].access.userId,
    },
    {
      action: "view",
      entityId: "all",
      entityType: "user_list",
      module: "identity",
      sensitiveView: true,
      userId: 9,
    },
  );

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/users"]?.get);
  assert.equal(openapi.components.schemas.Users.properties.users.maxItems, 1_000);
});

test("non-admin access is forbidden before database or audit work", async (t) => {
  const database = fakeDatabase();
  let auditCalls = 0;
  const app = await createUsersApp({
    context: { ...adminContext, roles: ["supply_chain"] },
    database,
    audit: () => {
      auditCalls += 1;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/users" });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "FORBIDDEN");
  assert.equal(database.executions.length, 0);
  assert.equal(database.queries.length, 0);
  assert.equal(auditCalls, 0);
  assertPrivateNoStore(response);
});

test("admin local preview preserves the legacy empty response without dependencies", async (t) => {
  const app = await createUsersApp({
    context: { ...adminContext, userId: 0, localPreview: true },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/users" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { users: [], preview: true });
  assertPrivateNoStore(response);
});

test("expiry write failures and malformed rows fail through the sanitized boundary", async () => {
  for (const database of [
    fakeDatabase({ executeError: new Error("UPDATE user_roles secret SQL") }),
    fakeDatabase({ users: [userRow(1, { accountStatus: "corrupt" })] }),
  ]) {
    const app = await createUsersApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users",
        headers: { "x-request-id": "users-fail-closed" },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
        requestId: "users-fail-closed",
      });
      assert.doesNotMatch(response.body, /user_roles|corrupt|secret/u);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("account lifecycle OpenAPI exposes only the frozen creation roles", async (t) => {
  const app = await createUsersApp();
  t.after(() => app.close());

  await app.ready();
  const openapi = app.swagger();
  for (const path of [
    "/api/v1/users/accounts",
    "/api/v1/users/password-reset",
    "/api/v1/users/disable",
    "/api/v1/users/restore",
  ]) {
    assert.ok(openapi.paths[path]?.post, `${path} must be registered`);
  }
  const createSchema = openapi.paths["/api/v1/users/accounts"].post
    .requestBody.content["application/json"].schema;
  assert.deepEqual(createSchema.properties.roleCode.enum, [
    "supply_chain",
    "finance",
    "company_qc",
    "receiver",
  ]);
  assert.equal(createSchema.properties.initialPassword.minLength, 12);
  assert.equal(createSchema.additionalProperties, false);
});

test("non-admin and local preview cannot execute account lifecycle commands", async () => {
  const cases = [
    { context: { ...adminContext, roles: ["supply_chain"] }, label: "non-admin" },
    { context: { ...adminContext, localPreview: true, sessionId: null, userId: 0 }, label: "preview" },
  ];
  const routes = [
    ["/api/v1/users/accounts", validCreatePayload],
    ["/api/v1/users/password-reset", { userId: 10, newPassword: "Replacement!234" }],
    ["/api/v1/users/disable", { userId: 10 }],
    ["/api/v1/users/restore", { userId: 10 }],
  ];

  for (const fixture of cases) {
    const database = fakeDatabase();
    const app = await createUsersApp({ context: fixture.context, database });
    try {
      for (const [index, [url, payload]] of routes.entries()) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: writeHeaders(`${fixture.label}-lifecycle-${index}-0001`),
          payload,
        });
        assert.equal(response.statusCode, 403, `${fixture.label} ${url}`);
        assert.equal(response.json().code, "FORBIDDEN");
      }
      assert.equal(database.executions.length, 0);
      assert.equal(database.queries.length, 0);
    } finally {
      await app.close();
    }
  }
});

test("account creation rejects governed and externally-bound roles before database work", async (t) => {
  const database = fakeDatabase();
  const app = await createUsersApp({ database });
  t.after(() => app.close());

  for (const [index, roleCode] of ["admin", "factory", "supplier_qc"].entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/users/accounts",
      headers: writeHeaders(`invalid-create-role-${index}-0001`),
      payload: { ...validCreatePayload, roleCode },
    });
    assert.equal(response.statusCode, 400, roleCode);
  }
  assert.equal(database.executions.length, 0);
  assert.equal(database.queries.length, 0);
});

test("create and reset reject weak passwords before database work", async (t) => {
  const database = fakeDatabase();
  const app = await createUsersApp({ database });
  t.after(() => app.close());

  const create = await app.inject({
    method: "POST",
    url: "/api/v1/users/accounts",
    headers: writeHeaders("weak-create-password-0001"),
    payload: { ...validCreatePayload, initialPassword: "weakpassword1" },
  });
  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/users/password-reset",
    headers: writeHeaders("weak-reset-password-0001"),
    payload: { userId: 10, newPassword: "weakpassword1" },
  });

  assert.equal(create.statusCode, 400);
  assert.equal(reset.statusCode, 400);
  assert.equal(create.json().code, "BAD_REQUEST");
  assert.equal(reset.json().code, "BAD_REQUEST");
  assert.equal(database.executions.length, 0);
  assert.equal(database.queries.length, 0);
});
