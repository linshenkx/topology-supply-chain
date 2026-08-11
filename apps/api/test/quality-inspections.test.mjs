import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import {
  registerQualityInspectionsModule,
} from "../dist/modules/quality-inspections/index.js";

function inspectionRow(id, executionOrderId = id) {
  return {
    id,
    executionOrderId,
    stage: "finished_goods",
    inspectionMethod: "sampling",
    batchQuantity: 100,
    inspectedQuantity: 20,
    passedQuantity: 19,
    failedQuantity: 1,
    passRateBps: 9500,
    qualityRuleId: 7,
    usedItemTypeFallback: 0,
    skuRuleReminderStatus: "not_needed",
    defectReason: "minor defect",
    systemResult: "passed",
    requestedResult: null,
    requiresApproval: 0,
    finalResult: "passed",
    quarantineTriggered: 0,
    fullInspectionRequired: 0,
    sourceInspectionId: null,
    releasedQuantity: 0,
    dispositionStatus: "not_needed",
    inspectorType: "supplier_qc",
    submittedBy: 9,
    createdAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
    updatedAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
  };
}

function fakeDatabase(handler = () => []) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return handler(sql, params);
    },
    async execute() {
      throw new Error("quality-inspections GET must not write");
    },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerQualityInspectionsModule(app, {
    authenticate: async () =>
      context ?? {
        factoryId: null,
        supplierId: null,
        localPreview: false,
        roles: ["admin"],
      },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("internal roles read the stable latest 200 without organization filters", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
    const database = fakeDatabase(() => [inspectionRow(2), inspectionRow(1)]);
    const app = await createApp({
      context: {
        factoryId: null,
        supplierId: null,
        localPreview: false,
        roles: [role],
      },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/quality-inspections",
      });
      assert.equal(response.statusCode, 200, role);
      assert.deepEqual(response.json().inspections.map((row) => row.id), [2, 1]);
      assertPrivateNoStore(response);
      const openapi = app.swagger();
      assert.ok(openapi.paths["/api/v1/quality-inspections"]?.get);
      assert.equal(
        openapi.components.schemas.QualityInspections.properties.inspections
          .maxItems,
        200,
      );
      assert.equal(database.queries.length, 1);
      assert.doesNotMatch(database.queries[0].sql, /WHERE EXISTS/u);
      assert.match(
        database.queries[0].sql,
        /ORDER BY inspections\.created_at DESC, inspections\.id DESC\s+LIMIT 200$/u,
      );
      assert.deepEqual(database.queries[0].params, []);
    } finally {
      await app.close();
    }
  }
});

test("supplier_qc is SQL-scoped to its supplier and cannot see another supplier", async (t) => {
  const database = fakeDatabase((_sql, params) =>
    params[0] === 11 ? [inspectionRow(11)] : [inspectionRow(22)],
  );
  const app = await createApp({
    context: {
      factoryId: null,
      supplierId: 11,
      localPreview: false,
      roles: ["supplier_qc"],
    },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/quality-inspections",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().inspections.map((row) => row.id), [11]);
  assert.match(database.queries[0].sql, /INNER JOIN order_items AS item/u);
  assert.match(database.queries[0].sql, /item\.supplier_id = \?/u);
  assert.ok(
    database.queries[0].sql.indexOf("item.supplier_id = ?") <
      database.queries[0].sql.indexOf("ORDER BY inspections.created_at"),
  );
  assert.deepEqual(database.queries[0].params, [11]);
});

test("factory is SQL-scoped before LIMIT and cannot see another factory", async (t) => {
  const database = fakeDatabase((_sql, params) =>
    params[0] === 3 ? [inspectionRow(3)] : [inspectionRow(4)],
  );
  const app = await createApp({
    context: {
      factoryId: 3,
      supplierId: null,
      localPreview: false,
      roles: ["factory"],
    },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/quality-inspections",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().inspections.map((row) => row.id), [3]);
  assert.match(database.queries[0].sql, /execution\.factory_id = \?/u);
  assert.ok(
    database.queries[0].sql.indexOf("execution.factory_id = ?") <
      database.queries[0].sql.indexOf("LIMIT 200"),
  );
  assert.deepEqual(database.queries[0].params, [3]);
});

test("mixed external roles receive only the union of their two SQL scopes", async (t) => {
  const database = fakeDatabase(() => [inspectionRow(3), inspectionRow(11)]);
  const app = await createApp({
    context: {
      factoryId: 3,
      supplierId: 11,
      localPreview: false,
      roles: ["factory", "supplier_qc"],
    },
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/quality-inspections",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().inspections.map((row) => row.id), [3, 11]);
  assert.match(
    database.queries[0].sql,
    /execution\.factory_id = \? OR item\.supplier_id = \?/u,
  );
  assert.deepEqual(database.queries[0].params, [3, 11]);
});

test("missing or malformed external organization ids fail closed before SQL", async () => {
  const denied = [
    { roles: ["supplier_qc"], supplierId: null, factoryId: null },
    { roles: ["supplier_qc"], supplierId: 0, factoryId: null },
    { roles: ["supplier_qc"], supplierId: 1.5, factoryId: null },
    { roles: ["factory"], supplierId: null, factoryId: null },
    { roles: ["factory"], supplierId: null, factoryId: -1 },
  ];
  for (const context of denied) {
    const database = fakeDatabase();
    const app = await createApp({
      context: { ...context, localPreview: false },
      database,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/quality-inspections",
      });
      assert.equal(response.statusCode, 403, JSON.stringify(context));
      assert.equal(response.json().code, "FORBIDDEN");
      assert.equal(database.queries.length, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("real serializer preserves a nullable quality finalResult as null", async (t) => {
  const database = fakeDatabase(() => [
    { ...inspectionRow(1), finalResult: null },
  ]);
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/quality-inspections",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().inspections[0].finalResult, null);
  assert.equal(response.json().inspections[0].requestedResult, null);
  assert.equal(response.json().inspections[0].sourceInspectionId, null);
});

test("preview, missing database, and malformed rows fail through the intended boundaries", async () => {
  const preview = await createApp({
    context: {
      factoryId: null,
      supplierId: null,
      localPreview: true,
      roles: ["admin"],
    },
  });
  try {
    const response = await preview.inject({
      method: "GET",
      url: "/api/v1/quality-inspections",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { inspections: [], preview: true });
    assertPrivateNoStore(response);
  } finally {
    await preview.close();
  }

  for (const [database, requestId] of [
    [undefined, "quality-no-db"],
    [fakeDatabase(() => [{ ...inspectionRow(1), finalResult: "leaked_sql" }]), "quality-bad-row"],
  ]) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/quality-inspections",
        headers: { "x-request-id": requestId },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /leaked_sql|Quality inspections unavailable/u);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
