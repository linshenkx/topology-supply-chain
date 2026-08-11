import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerAuditLogsModule } from "../dist/modules/audit-logs/index.js";

const fixedNow = () => new Date("2026-08-11T12:34:56.789Z");
const adminContext = {
  userId: 9,
  email: "admin@example.com",
  name: "Admin",
  roles: ["admin"],
  factoryId: null,
  supplierId: null,
  organizationName: "Topology",
  localPreview: false,
};

function auditRow(id, overrides = {}) {
  return {
    id,
    actorUserId: 9,
    actorName: "Admin",
    actorEmail: "admin@example.com",
    action: "view",
    module: "财务",
    entityType: "invoice",
    entityId: String(id),
    businessNo: `INV-${id}`,
    ipAddress: "203.0.113.8",
    deviceId: "device-1",
    sensitiveView: 1,
    exported: 0,
    createdAt: "2026-08-11 10:00:00.000",
    archiveAfter: "2031-08-11T10:00:00.000Z",
    ...overrides,
  };
}

function fakeDatabase({ count = 1, rows = [auditRow(1)] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return sql.includes("COUNT(*)") ? [{ count }] : rows;
    },
    async execute() {
      throw new Error("Audit log GET must not execute SQL writes");
    },
  };
}

async function createAuditApp({
  audit,
  context,
  database,
  exporter,
} = {}) {
  const app = await buildApp({ logger: false });
  await registerAuditLogsModule(app, {
    authenticate: async () => context ?? adminContext,
    database,
    exporter,
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

test("admin filters and paginates audit rows with parameterized stable SQL and view audit", async (t) => {
  const row = auditRow(1, {
    actorUserId: null,
    actorName: null,
    actorEmail: null,
    businessNo: null,
    ipAddress: null,
    deviceId: null,
  });
  const database = fakeDatabase({ count: 21, rows: [row] });
  const audits = [];
  const app = await createAuditApp({
    database,
    audit: async (event) => audits.push(event),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/audit-logs?actor=Admin&module=%E8%B4%A2%E5%8A%A1&sensitive=true&archiveScope=archived&page=2&pageSize=10",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body, {
    logs: [
      {
        ...row,
        sensitiveView: true,
        exported: false,
      },
    ],
    total: 21,
    page: 2,
    pageSize: 10,
  });
  assert.equal(body.logs[0].actorUserId, null);
  assert.equal(body.logs[0].actorName, null);
  assert.equal(body.logs[0].businessNo, null);
  const rowQuery = database.queries.find(({ sql }) =>
    sql.includes("ORDER BY audit_logs.created_at"),
  );
  const countQuery = database.queries.find(({ sql }) => sql.includes("COUNT(*)"));
  assert.ok(rowQuery);
  assert.ok(countQuery);
  assert.match(
    rowQuery.sql,
    /ORDER BY audit_logs\.created_at DESC, audit_logs\.id DESC\s+LIMIT \? OFFSET \?$/u,
  );
  assert.doesNotMatch(rowQuery.sql, /Admin|财务/u);
  assert.deepEqual(rowQuery.params, [
    "%Admin%",
    "%Admin%",
    "财务",
    1,
    "2026-08-11T12:34:56.789Z",
    10,
    10,
  ]);
  assert.deepEqual(countQuery.params, rowQuery.params.slice(0, -2));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "view_audit_logs");
  assert.equal(audits[0].sensitiveView, true);
  assert.deepEqual(audits[0].after.page, 2);
  assert.equal(audits[0].after.filters.module, "财务");

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/audit-logs"]?.get);
  assert.equal(openapi.components.schemas.AuditLogs.properties.logs.maxItems, 100);
  assert.equal(
    openapi.paths["/api/v1/audit-logs"].get.responses[200].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/AuditLogs",
  );
  assert.equal(
    openapi.paths["/api/v1/audit-logs"].get.responses[200].content[
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ].schema.format,
    "binary",
  );
  assert.equal(
    openapi.paths["/api/v1/audit-logs"].get.parameters.find(
      (parameter) => parameter.name === "page",
    ).schema.maxLength,
    500,
  );
});

test("audit export uses the injected XLSX port, a fixed cap, watermark, and export audit", async (t) => {
  const database = fakeDatabase({ rows: [auditRow(2)] });
  const exports = [];
  const audits = [];
  const app = await createAuditApp({
    database,
    exporter: {
      async createXlsx(input) {
        exports.push(input);
        return Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
      },
    },
    audit: async (event) => audits.push(event),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/audit-logs?archiveScope=all&export=xlsx",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.equal(
    response.headers["content-type"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="topology-audit-logs-20260811123456.xlsx"',
  );
  assert.deepEqual(response.rawPayload, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(exports.length, 1);
  assert.equal(exports[0].companyName, "广州拓扑睡眠科技有限公司");
  assert.match(exports[0].watermark, /Admin（admin@example\.com）/u);
  assert.equal(exports[0].rows.length, 1);
  assert.deepEqual(exports[0].filterSummary, {
    archiveScope: "all",
    export: "xlsx",
  });
  assert.match(database.queries[0].sql, /LIMIT \?$/u);
  assert.deepEqual(database.queries[0].params, [5_000]);
  assert.equal(audits[0].action, "export_audit_logs");
  assert.equal(audits[0].exported, true);
  assert.deepEqual(audits[0].after, { count: 1 });
});

test("non-admin and unbounded pagination fail before data access", async () => {
  const database = fakeDatabase();
  for (const fixture of [
    {
      context: { ...adminContext, roles: ["finance"] },
      url: "/api/v1/audit-logs",
      status: 403,
      code: "FORBIDDEN",
    },
    {
      context: adminContext,
      url: "/api/v1/audit-logs?page=1000001",
      status: 400,
      code: "BAD_REQUEST",
    },
  ]) {
    const app = await createAuditApp({ context: fixture.context, database });
    try {
      const response = await app.inject({ method: "GET", url: fixture.url });
      assert.equal(response.statusCode, fixture.status);
      assert.equal(response.json().code, fixture.code);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
  assert.equal(database.queries.length, 0);
});

test("legacy audit parameter coercion and free-form dates remain compatible", async (t) => {
  const database = fakeDatabase();
  const app = await createAuditApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/audit-logs?page=1.5&pageSize=5&dateFrom=not-a-date",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().page, 1.5);
  assert.equal(response.json().pageSize, 10);
  const rowQuery = database.queries.find(({ sql }) =>
    sql.includes("ORDER BY audit_logs.created_at"),
  );
  assert.deepEqual(rowQuery.params, ["not-a-date 00:00:00", fixedNow().toISOString(), 10, 5]);
});

test("local preview is empty while missing export wiring and malformed rows fail closed", async () => {
  const preview = await createAuditApp({
    context: { ...adminContext, userId: 0, localPreview: true },
  });
  try {
    const response = await preview.inject({
      method: "GET",
      url: "/api/v1/audit-logs?page=9&pageSize=100",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { logs: [], total: 0, page: 1, pageSize: 20 });
  } finally {
    await preview.close();
  }

  for (const options of [
    { database: fakeDatabase(), url: "/api/v1/audit-logs?export=xlsx" },
    {
      database: fakeDatabase({ rows: [auditRow(1, { sensitiveView: "yes" })] }),
      url: "/api/v1/audit-logs",
    },
  ]) {
    const app = await createAuditApp(options);
    try {
      const response = await app.inject({
        method: "GET",
        url: options.url,
        headers: { "x-request-id": "audit-fail-closed" },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /sensitiveView|yes|XLSX/u);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
