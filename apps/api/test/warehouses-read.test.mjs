import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerWarehousesModule } from "../dist/modules/warehouses/index.js";

const warehouse = (id, status = "active") => ({
  id, code: `WH-${id}`, name: `Warehouse ${id}`, type: id === 1 ? "factory" : "company",
  factoryId: id === 1 ? 9 : null, address: "GZ", status,
  createdAt: "2026-01-01", updatedAt: `2026-08-0${id}`,
});
const factory = { id: 9, name: "Factory 9", code: "F-9", status: "active", createdAt: "2026-01-01", updatedAt: "2026-08-11" };

function fakeDatabase({ warehouses = [warehouse(2, "merged:1"), warehouse(1)] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM warehouses")) return warehouses;
      if (sql.includes("FROM factories")) return [factory];
      if (sql.includes("FROM inventory_batches")) return [{ id: 10, warehouseId: 1, availableQuantity: 10, lockedQuantity: 2, defectiveQuantity: 1, pendingInspectionQuantity: 3, quarantineQuantity: 4 }];
      if (sql.includes("FROM inventory_reservations")) return [{ batchId: 10, reservedQuantity: 3, status: "active" }];
      if (sql.includes("FROM inventory_transfers")) return [{ fromWarehouseId: 1, toWarehouseId: 2, status: "shipped" }];
      if (sql.includes("FROM purchase_plan_items")) return [{ purchasePlanId: 50, warehouseId: 1 }];
      if (sql.includes("FROM purchase_plans")) return [{ id: 50, status: "confirmed" }];
      throw new Error("Unexpected SQL");
    },
    async execute() { throw new Error("warehouses GET must not write"); },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerWarehousesModule(app, {
    authenticate: async () => context ?? { localPreview: false, roles: ["admin"] },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("warehouse GET preserves blocker aggregation and merged status normalization", async (t) => {
  const database = fakeDatabase();
  const app = await createApp({ database });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/v1/warehouses" });
  assert.equal(response.statusCode, 200);
  assertPrivate(response);
  const body = response.json();
  assert.deepEqual(body.factories.map((row) => row.id), [9]);
  assert.deepEqual(body.warehouses[0], {
    id: 2, code: "WH-2", name: "Warehouse 2", type: "company", factoryId: null,
    address: "GZ", status: "merged", createdAt: "2026-01-01", updatedAt: "2026-08-02",
    mergedIntoWarehouseId: 1,
    blockers: { inventory: 0, reservations: 0, transfers: 1, unfinishedBusiness: 0 },
  });
  assert.deepEqual(body.warehouses[1].blockers, { inventory: 20, reservations: 3, transfers: 1, unfinishedBusiness: 1 });
  const limits = database.queries.map(({ sql }) => Number(sql.match(/LIMIT (\d+)$/u)?.[1]));
  assert.deepEqual(limits, [500, 500, 5000, 5000, 5000, 5000, 2000]);
  assert.ok(database.queries.every(({ sql }) => /ORDER BY/u.test(sql)));
  assert.ok(app.swagger().paths["/api/v1/warehouses"]?.get);
  assert.equal(app.swagger().components.schemas.Warehouses.properties.warehouses.maxItems, 500);
});

test("warehouse preview and authorization short-circuit all reads", async () => {
  const preview = await createApp({ context: { localPreview: true, roles: ["supply_chain"] } });
  try {
    const response = await preview.inject({ method: "GET", url: "/api/v1/warehouses" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { warehouses: [], factories: [], preview: true });
    assertPrivate(response);
  } finally { await preview.close(); }

  const database = fakeDatabase();
  const denied = await createApp({ database, context: { localPreview: false, roles: ["factory"] } });
  try {
    const response = await denied.inject({ method: "GET", url: "/api/v1/warehouses" });
    assert.equal(response.statusCode, 403);
    assert.equal(database.queries.length, 0);
  } finally { await denied.close(); }
});

test("warehouse database errors and malformed merged targets are sanitized", async () => {
  for (const database of [
    fakeDatabase({ warehouses: [warehouse(1, "merged:not-a-number")] }),
    { query: async () => { throw new Error("SELECT secret FROM credentials"); }, execute: async () => ({ affectedRows: 0 }) },
  ]) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/warehouses" });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /SELECT|credential|merged/u);
      assertPrivate(response);
    } finally { await app.close(); }
  }
});
