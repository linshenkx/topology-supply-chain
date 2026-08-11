import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerImportsModule } from "../dist/modules/imports/index.js";

function stagingRow(id, importBatchId, sourceRowNo, businessKey, value) {
  return {
    id,
    importBatchId,
    sourceRowNo,
    businessKey,
    normalizedJson: JSON.stringify(value),
  };
}

function fakeDatabase({ batches = [], stagingRows = [], queryError } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params: [...params] });
      if (queryError) throw queryError;
      if (sql.includes("FROM import_batches")) {
        return batches.filter((row) => row.id === params[0]);
      }
      if (sql.includes("FROM import_staging_rows")) {
        return stagingRows.filter((row) => row.importBatchId === params[0]);
      }
      throw new Error("Unexpected SQL");
    },
    async execute() {
      throw new Error("Import diff GET must not execute writes");
    },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerImportsModule(app, {
    authenticate: async () =>
      context ?? { localPreview: false, roles: ["supply_chain"] },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("diff is stable and remains closed over the current and duplicate batch ids", async (t) => {
  const database = fakeDatabase({
    batches: [{ id: 20, duplicateOfBatchId: 10 }],
    stagingRows: [
      stagingRow(1, 10, 1, "A", { sku: "A", quantity: 1, obsolete: true }),
      stagingRow(2, 10, 2, "B", { sku: "B", quantity: 2 }),
      stagingRow(3, 10, 3, "D", { sku: "D", quantity: 4 }),
      stagingRow(4, 20, 1, "A", { sku: "A", quantity: 3, addedField: "yes" }),
      stagingRow(5, 20, 2, "B", { sku: "B", quantity: 2 }),
      stagingRow(6, 20, 4, "C", { sku: "C", quantity: 5 }),
    ],
  });
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/imports/diff?batchId=20",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json(), {
    added: [{ key: "C", value: { sku: "C", quantity: 5 } }],
    changed: [
      {
        key: "A",
        fields: [
          { field: "quantity", oldValue: 1, newValue: 3 },
          { field: "obsolete", oldValue: true, newValue: null },
          { field: "addedField", oldValue: null, newValue: "yes" },
        ],
      },
    ],
    removed: [{ key: "D", value: { sku: "D", quantity: 4 } }],
  });

  assert.deepEqual(database.queries[0].params, [20]);
  assert.match(database.queries[0].sql, /ORDER BY id ASC\s+LIMIT 2$/u);
  assert.deepEqual(
    database.queries.slice(1).map((query) => query.params),
    [[20], [10]],
  );
  for (const query of database.queries.slice(1)) {
    assert.match(
      query.sql,
      /ORDER BY source_row_no ASC, id ASC\s+LIMIT 5001$/u,
    );
  }

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/imports/diff"]?.get);
  assert.equal(openapi.components.schemas.ImportDiff.properties.added.maxItems, 5_000);
});

test("unknown and non-duplicate batches preserve the legacy empty diff", async () => {
  for (const batches of [[], [{ id: 20, duplicateOfBatchId: null }]]) {
    const database = fakeDatabase({ batches });
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/imports/diff?batchId=20",
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        added: [],
        changed: [],
        removed: [],
      });
      assert.equal(database.queries.length, 1);
    } finally {
      await app.close();
    }
  }
});

test("local preview preserves the legacy empty response without a database", async (t) => {
  const app = await createApp({
    context: { localPreview: true, roles: ["admin"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/imports/diff?batchId=20",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    added: [],
    changed: [],
    removed: [],
    preview: true,
  });
  assertPrivateNoStore(response);
});

test("admin has organization-wide import diff read access", async (t) => {
  const database = fakeDatabase();
  const app = await createApp({
    database,
    context: { localPreview: false, roles: ["admin"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/imports/diff?batchId=20",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    added: [],
    changed: [],
    removed: [],
  });
  assert.equal(database.queries.length, 1);
});

test("roles and query validation fail before database access", async () => {
  const deniedDatabase = fakeDatabase();
  const denied = await createApp({
    database: deniedDatabase,
    context: { localPreview: false, roles: ["factory"] },
  });
  try {
    const response = await denied.inject({
      method: "GET",
      url: "/api/v1/imports/diff?batchId=20",
    });
    assert.equal(response.statusCode, 403);
    assert.equal(deniedDatabase.queries.length, 0);
    assertPrivateNoStore(response);
  } finally {
    await denied.close();
  }

  for (const url of [
    "/api/v1/imports/diff",
    "/api/v1/imports/diff?batchId=0",
    "/api/v1/imports/diff?batchId=-1",
    "/api/v1/imports/diff?batchId=1.5",
  ]) {
    const database = fakeDatabase();
    const app = await createApp({ database });
    try {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(response.json().code, "BAD_REQUEST");
      assert.equal(database.queries.length, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("duplicate effective keys, wrong batch ownership, malformed JSON, and database errors fail closed", async () => {
  const cases = [
    fakeDatabase({
      batches: [{ id: 20, duplicateOfBatchId: 10 }],
      stagingRows: [
        stagingRow(1, 20, 1, "A", { sku: "A" }),
        stagingRow(2, 20, 2, "A", { sku: "A-duplicate" }),
      ],
    }),
    {
      ...fakeDatabase({ batches: [{ id: 20, duplicateOfBatchId: 10 }] }),
      async query(sql, params = []) {
        this.queries.push({ sql, params: [...params] });
        if (sql.includes("FROM import_batches")) {
          return [{ id: 20, duplicateOfBatchId: 10 }];
        }
        if (params[0] === 20) {
          return [stagingRow(1, 999, 1, "A", { sku: "A" })];
        }
        return [];
      },
    },
    {
      ...fakeDatabase({ batches: [{ id: 20, duplicateOfBatchId: 10 }] }),
      async query(sql, params = []) {
        this.queries.push({ sql, params: [...params] });
        if (sql.includes("FROM import_batches")) {
          return [{ id: 20, duplicateOfBatchId: 10 }];
        }
        if (params[0] === 20) {
          return [{ ...stagingRow(1, 20, 1, "A", {}), normalizedJson: "{secret" }];
        }
        return [];
      },
    },
    fakeDatabase({
      queryError: new Error("mysql://root:secret@database/import_staging_rows"),
    }),
  ];

  for (const database of cases) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/imports/diff?batchId=20",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /mysql|root|secret|999|staging/iu);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
