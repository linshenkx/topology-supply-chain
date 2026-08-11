import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerStocktakesModule } from "../dist/modules/stocktakes/index.js";

const warehouse = { id: 1, code: "WH-1", name: "Factory WH", type: "factory", factoryId: 9, address: "GZ", status: "active", createdAt: "2026-01-01", updatedAt: "2026-08-11" };
const factory = { id: 9, name: "Factory 9", code: "F-9", status: "active", createdAt: "2026-01-01", updatedAt: "2026-08-11" };
const task = { id: 10, stocktakeNo: "ST-10", warehouseId: 1, scope: "full_warehouse", dueDate: "2026-08-20", status: "first_count", frozenAt: "2026-08-10", createdBy: 5, assignedFactoryId: 99, createdAt: "2026-08-10", updatedAt: "2026-08-10" };
const actual = { id: 30, stocktakeId: 10, batchId: 20, sku: "SKU-1", countRound: 1, availableQuantity: 8, lockedQuantity: 2, defectiveQuantity: 0, pendingInspectionQuantity: 1, totalQuantity: 11, countedBy: 6, countedAt: "2026-08-11" };

function fakeDatabase({ batchRows = [{ id: 20, batchNo: "B-20" }], countRows = [actual], targetRows = [{ batchId: 20, sku: "SKU-1" }], tasks = [task] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM warehouses")) return [warehouse];
      if (sql.includes("FROM stocktakes")) return tasks;
      if (sql.includes("FROM stocktake_counts") && sql.includes("count_round = ?")) return targetRows;
      if (sql.includes("FROM stocktake_counts") && sql.includes("count_round IN")) return countRows;
      if (sql.includes("FROM inventory_batches")) return batchRows;
      if (sql.includes("FROM factories")) return [factory];
      throw new Error("Unexpected SQL");
    },
    async execute() { throw new Error("stocktakes GET must not write"); },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerStocktakesModule(app, {
    authenticate: async () => context ?? { factoryId: null, localPreview: false, roles: ["admin"] },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("factory stocktakes follow warehouse scope while blind snapshots omit frozen quantities", async (t) => {
  const database = fakeDatabase();
  const app = await createApp({ database, context: { factoryId: 9, localPreview: false, roles: ["factory"] } });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/v1/stocktakes" });
  assert.equal(response.statusCode, 200);
  assertPrivate(response);
  const body = response.json();
  assert.equal(body.canCreate, false);
  assert.deepEqual(body.factories, []);
  assert.deepEqual(body.stocktakes[0].targets, [{ batchId: 20, sku: "SKU-1", batchNo: "B-20" }]);
  assert.equal(body.stocktakes[0].counts[0].availableQuantity, 8);
  assert.equal(body.stocktakes[0].assignedFactoryId, 99, "legacy GET scope is warehouse ownership, not assignedFactoryId");
  const targetQuery = database.queries.find(({ sql }) => sql.includes("count_round = ?"));
  assert.doesNotMatch(targetQuery.sql, /available_quantity|total_quantity|counted_by/u);
  assert.match(database.queries[0].sql, /WHERE factory_id = \?/u);
  assert.deepEqual(database.queries[0].params, [9]);
  assert.ok(app.swagger().paths["/api/v1/stocktakes"]?.get);
  assert.equal(app.swagger().components.schemas.Stocktakes.properties.stocktakes.maxItems, 100);
});

test("internal stocktakes include factory choices and deterministic bounded SQL", async (t) => {
  const database = fakeDatabase({ tasks: [] });
  const app = await createApp({ database });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/v1/stocktakes" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canCreate, true);
  assert.deepEqual(response.json().factories.map((row) => row.id), [9]);
  assert.match(database.queries[1].sql, /ORDER BY created_at DESC, id DESC\s+LIMIT 100$/u);
});

test("stocktakes preview and authorization short-circuit data, while dangling targets fail closed", async () => {
  const preview = await createApp({ context: { factoryId: null, localPreview: true, roles: ["admin"] } });
  try {
    const response = await preview.inject({ method: "GET", url: "/api/v1/stocktakes" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { stocktakes: [], warehouses: [], factories: [], canCreate: true, preview: true });
    assertPrivate(response);
  } finally { await preview.close(); }

  const deniedDatabase = fakeDatabase();
  const denied = await createApp({ database: deniedDatabase, context: { factoryId: null, localPreview: false, roles: ["receiver"] } });
  try {
    const response = await denied.inject({ method: "GET", url: "/api/v1/stocktakes" });
    assert.equal(response.statusCode, 403);
    assert.equal(deniedDatabase.queries.length, 0);
  } finally { await denied.close(); }

  const malformed = await createApp({ database: fakeDatabase({ batchRows: [] }) });
  try {
    const response = await malformed.inject({ method: "GET", url: "/api/v1/stocktakes" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().message, "Internal Server Error");
    assert.doesNotMatch(response.body, /B-20|SELECT/u);
  } finally { await malformed.close(); }
});
