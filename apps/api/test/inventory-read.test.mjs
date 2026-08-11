import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerInventoryModule } from "../dist/modules/inventory/index.js";

const warehouse = (id, factoryId = 9) => ({
  id, code: `WH-${id}`, name: `Warehouse ${id}`, type: "factory", factoryId,
  address: "GZ", status: "active", createdAt: "2026-01-01", updatedAt: "2026-08-11",
});
const batch = (id, warehouseId = 1) => ({
  id, batchNo: `B-${id}`, warehouseId, sku: "SKU-1", productionDate: null,
  inboundDate: "2026-07-01", expiryDate: null, productionDateEstimated: 0,
  expiryDateEstimated: 0, availableQuantity: 10, lockedQuantity: 2,
  defectiveQuantity: 0, pendingInspectionQuantity: 1, quarantineQuantity: 0,
  ownership: "company", expiryStatus: "normal", createdAt: "2026-07-01", updatedAt: "2026-08-11",
});
const reservation = (id, batchId = 1) => ({
  id, batchId, entityType: "production_order", entityId: 7, requestedQuantity: 3,
  reservedQuantity: 3, shortageQuantity: 0, priority: 1, status: "active", createdBy: 5,
  createdAt: "2026-08-10", updatedAt: "2026-08-10",
});
const transfer = (id) => ({
  id, transferNo: `TR-${id}`, fromWarehouseId: 1, toWarehouseId: 2, sku: "SKU-1",
  quantity: 2, reason: "move", status: "shipped", requestedBy: 5, approvedBy: null,
  approvedAt: null, shippedAt: "2026-08-10", receivedAt: null,
  createdAt: "2026-08-10", updatedAt: "2026-08-10",
});

function fakeDatabase({ warehouses = [warehouse(1)], batches = [batch(1)], reservations = [reservation(1)], transfers = [transfer(1)] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM warehouses")) return warehouses;
      if (sql.includes("FROM inventory_batches")) return batches;
      if (sql.includes("FROM inventory_reservations")) return reservations;
      if (sql.includes("FROM inventory_transfers")) return transfers;
      throw new Error("Unexpected SQL");
    },
    async execute() { throw new Error("inventory GET must not write"); },
  };
}

async function createApp({ context, database, audit } = {}) {
  const app = await buildApp({ logger: false });
  await registerInventoryModule(app, {
    authenticate: async () => context ?? { userId: 5, factoryId: null, localPreview: false, roles: ["admin"] },
    ...(database === undefined ? {} : { database }),
    ...(audit === undefined ? {} : { audit }),
  });
  return app;
}

function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("factory inventory is warehouse-scoped, preserves ownership visibility, and audits sensitive reads", async (t) => {
  const database = fakeDatabase({ warehouses: [warehouse(1), warehouse(2)] });
  const audits = [];
  const app = await createApp({
    database,
    context: { userId: 5, factoryId: 9, localPreview: false, roles: ["factory"] },
    audit: async (event) => audits.push(event),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/inventory?warehouseId=1&sku=SKU-1&sensitive=1", headers: { "x-request-id": "inv-1", "cf-connecting-ip": "203.0.113.10", "x-topology-device-id": "device-7" } });
  assert.equal(response.statusCode, 200);
  assertPrivate(response);
  const body = response.json();
  assert.equal(body.batches[0].ownership, "company");
  assert.equal(body.batches[0].productionDate, null);
  assert.equal(body.batches[0].expiryDate, null);
  assert.equal(body.transfers[0].approvedBy, null);
  assert.deepEqual(body.warehouses.map((row) => row.id), [1, 2]);
  assert.equal(body.reservations[0].status, "active");
  assert.match(database.queries[0].sql, /WHERE factory_id = \?/u);
  assert.deepEqual(database.queries[0].params, [9]);
  assert.match(database.queries[1].sql, /warehouse_id IN \(\?\) AND sku = \?/u);
  assert.deepEqual(database.queries[1].params, [1, "SKU-1"]);
  assert.match(database.queries[1].sql, /ORDER BY expiry_date ASC, inbound_date DESC, id DESC/u);
  assert.equal(audits.length, 1);
  assert.deepEqual({ entityId: audits[0].entityId, requestId: audits[0].requestId, sensitiveView: audits[0].sensitiveView, ipAddress: audits[0].ipAddress, deviceId: audits[0].deviceId }, { entityId: 1, requestId: "inv-1", sensitiveView: true, ipAddress: "203.0.113.10", deviceId: "device-7" });
  assert.ok(app.swagger().paths["/api/v1/inventory"]?.get);
  assert.equal(app.swagger().components.schemas.Inventory.properties.batches.maxItems, 500);
});

test("inventory rejects malformed and unauthorized warehouse filters without widening scope", async () => {
  for (const url of [
    "/api/v1/inventory?warehouseId=not-a-number",
    "/api/v1/inventory?warehouseId=0",
    "/api/v1/inventory?warehouseId=-1",
    "/api/v1/inventory?warehouseId=1.5",
  ]) {
    const database = fakeDatabase();
    const audits = [];
    const app = await createApp({ database, context: { userId: 5, factoryId: 9, localPreview: false, roles: ["factory"] }, audit: async (event) => audits.push(event) });
    try {
      const response = await app.inject({ method: "GET", url: `${url}&sensitive=1` });
      assert.equal(response.statusCode, 400);
      assertPrivate(response);
      assert.equal(database.queries.length, 0, "invalid input must not become an all-warehouse query");
      assert.equal(audits.length, 0);
    } finally { await app.close(); }
  }

  const database = fakeDatabase();
  const app = await createApp({ database, context: { userId: 5, factoryId: 9, localPreview: false, roles: ["factory"] } });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/inventory?warehouseId=2" });
    assert.equal(response.statusCode, 403);
    assert.equal(database.queries.filter(({ sql }) => sql.includes("FROM inventory_batches")).length, 0);
  } finally { await app.close(); }
});

test("omitting warehouseId retains the legacy all-permitted-warehouses scope", async (t) => {
  const database = fakeDatabase({ warehouses: [warehouse(1), warehouse(2)], batches: [batch(1, 1), batch(2, 2)] });
  const app = await createApp({ database, context: { userId: 5, factoryId: 9, localPreview: false, roles: ["factory"] } });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/v1/inventory" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().batches.map((row) => row.warehouseId), [1, 2]);
  const batchQuery = database.queries.find(({ sql }) => sql.includes("FROM inventory_batches"));
  assert.match(batchQuery.sql, /warehouse_id IN \(\?, \?\)/u);
  assert.deepEqual(batchQuery.params, [1, 2]);
});

test("inventory preview, forbidden roles, missing audit ports, and malformed rows fail closed", async () => {
  const preview = await createApp({ context: { userId: 0, factoryId: null, localPreview: true, roles: ["admin"] } });
  try {
    const response = await preview.inject({ method: "GET", url: "/api/v1/inventory?sensitive=1" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { batches: [], preview: true });
    assertPrivate(response);
  } finally { await preview.close(); }

  const forbiddenDatabase = fakeDatabase();
  const forbidden = await createApp({ database: forbiddenDatabase, context: { userId: 5, factoryId: null, localPreview: false, roles: ["finance"] } });
  try {
    const response = await forbidden.inject({ method: "GET", url: "/api/v1/inventory" });
    assert.equal(response.statusCode, 403);
    assert.equal(forbiddenDatabase.queries.length, 0);
  } finally { await forbidden.close(); }

  for (const options of [
    { database: fakeDatabase(), url: "/api/v1/inventory?sensitive=1" },
    { database: fakeDatabase({ batches: [{ ...batch(1), availableQuantity: "10" }] }), url: "/api/v1/inventory" },
  ]) {
    const app = await createApp({ database: options.database });
    try {
      const response = await app.inject({ method: "GET", url: options.url });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(response.body, /availableQuantity|audit|SELECT/u);
      assertPrivate(response);
    } finally { await app.close(); }
  }
});
