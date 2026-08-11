import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerShipmentsModule } from "../dist/modules/shipments/index.js";

const shipment = (id, executionOrderId, destination) => ({
  id, executionOrderId, batchNo: `SHIP-${id}`, quantity: 10, plannedShipAt: "2026-08-10",
  shippedAt: null, carrier: "", logisticsNo: "", destination, requiresApproval: 0,
  deviationReason: null, status: "planned", createdAt: `2026-08-${10 - id}`,
  updatedAt: "2026-08-11",
});
const execution = (id, factoryId, orderItemId) => ({
  id, executionNo: `EX-${id}`, orderItemId, factoryId, bomId: null, plannedQuantity: 100,
  completedQuantity: 20, status: "in_progress", dueDate: null, plannedStartDate: null,
  plannedFinishDate: null, actualStartAt: null, actualFinishAt: null,
  createdAt: "2026-08-01", updatedAt: "2026-08-11",
});
const item = (id) => ({
  id, purchaseOrderId: 50 + id, sku: `SKU-${id}`, productName: `Product ${id}`,
  itemType: "finished", supplierId: null, quantity: 100, unitPriceTaxIncludedMinor: 1000,
  amountTaxIncludedMinor: 100000, dueDate: null, createdAt: "2026-08-01", updatedAt: "2026-08-11",
});
const evidence = { id: 101, deliveryBatchId: 1, fileKey: "shipment/1", fileName: "proof.jpg", createdAt: "2026-08-11" };
const receipt = { id: 201, deliveryBatchId: 2, receivedQuantity: 9, damagedQuantity: 1, receivedAt: "2026-08-11", evidenceFileKey: "receipt/2", exceptionReason: "damaged", receivedBy: 8, createdAt: "2026-08-11", updatedAt: "2026-08-11" };
const exception = { id: 301, executionOrderId: 12, factoryId: 10, type: "logistics_exception", description: "damage", evidenceFileKey: null, status: "open", submittedBy: 8, createdAt: "2026-08-11", updatedAt: "2026-08-11" };

function fakeDatabase({
  shipments = [shipment(1, 11, "Receiver A"), shipment(2, 12, "Receiver B")],
  executions = [execution(11, 9, 21), execution(12, 10, 22)],
  items = [item(21), item(22)], evidenceRows = [evidence], receiptRows = [receipt], exceptionRows = [exception],
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM delivery_batches")) return shipments;
      if (sql.includes("FROM execution_orders")) return executions.filter((row) => params.includes(row.id));
      if (sql.includes("FROM order_items")) return items.filter((row) => params.includes(row.id));
      if (sql.includes("FROM shipment_evidence")) return evidenceRows.filter((row) => params.includes(row.deliveryBatchId));
      if (sql.includes("FROM shipment_receipts")) return receiptRows.filter((row) => params.includes(row.deliveryBatchId));
      if (sql.includes("FROM exceptions")) return exceptionRows.filter((row) => params.includes(row.executionOrderId));
      throw new Error("Unexpected SQL");
    },
    async execute() { throw new Error("shipments GET must not write"); },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerShipmentsModule(app, {
    authenticate: async () => context ?? { factoryId: null, localPreview: false, organizationName: "Topology", roles: ["admin"] },
    ...(database === undefined ? {} : { database }),
  });
  return app;
}

function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("shipment scopes preserve global-limit then internal, receiver, and factory precedence", async () => {
  const cases = [
    { context: { factoryId: null, localPreview: false, organizationName: "Topology", roles: ["admin"] }, ids: [1, 2] },
    { context: { factoryId: 9, localPreview: false, organizationName: "Receiver B", roles: ["receiver", "factory"] }, ids: [2] },
    { context: { factoryId: 9, localPreview: false, organizationName: "Other", roles: ["factory"] }, ids: [1] },
  ];
  for (const current of cases) {
    const database = fakeDatabase();
    const app = await createApp({ context: current.context, database });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/shipments" });
      assert.equal(response.statusCode, 200);
      assertPrivate(response);
      assert.deepEqual(response.json().shipments.map((row) => row.id), current.ids);
      assert.match(database.queries[0].sql, /FROM delivery_batches\s+ORDER BY created_at DESC, id DESC\s+LIMIT 200$/u);
      assert.deepEqual(database.queries[0].params, []);
    } finally { await app.close(); }
  }
});

test("shipment enrichment closes evidence, receipts, and logistics exceptions over visible rows", async (t) => {
  const database = fakeDatabase();
  const app = await createApp({ database });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/v1/shipments" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.shipments[0].execution.factoryId, 9);
  assert.equal(body.shipments[0].execution.bomId, null);
  assert.equal(body.shipments[0].execution.dueDate, null);
  assert.equal(body.shipments[0].item.supplierId, null);
  assert.equal(body.shipments[0].shippedAt, null);
  assert.equal(body.shipments[0].item.id, 21);
  assert.deepEqual(body.shipments[0].evidence.map((row) => row.id), [101]);
  assert.deepEqual(body.shipments[1].receipts.map((row) => row.id), [201]);
  assert.deepEqual(body.shipments[1].exceptions.map((row) => row.id), [301]);
  const exceptionQuery = database.queries.find(({ sql }) => sql.includes("FROM exceptions"));
  assert.deepEqual(exceptionQuery.params, [11, 12, "logistics_exception"]);
  assert.match(exceptionQuery.sql, /ORDER BY execution_order_id ASC, id ASC\s+LIMIT 1001$/u);
  assert.ok(app.swagger().paths["/api/v1/shipments"]?.get);
  assert.equal(app.swagger().components.schemas.Shipments.properties.shipments.maxItems, 200);
});

test("shipments preview and forbidden roles avoid data, while broken relations fail closed", async () => {
  const preview = await createApp({ context: { factoryId: null, localPreview: true, organizationName: "Topology", roles: ["admin"] } });
  try {
    const response = await preview.inject({ method: "GET", url: "/api/v1/shipments" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { shipments: [], preview: true });
    assertPrivate(response);
  } finally { await preview.close(); }

  const deniedDatabase = fakeDatabase();
  const denied = await createApp({ database: deniedDatabase, context: { factoryId: null, localPreview: false, organizationName: "Topology", roles: ["finance"] } });
  try {
    const response = await denied.inject({ method: "GET", url: "/api/v1/shipments" });
    assert.equal(response.statusCode, 403);
    assert.equal(deniedDatabase.queries.length, 0);
  } finally { await denied.close(); }

  const malformed = await createApp({ database: fakeDatabase({ executions: [] }) });
  try {
    const response = await malformed.inject({ method: "GET", url: "/api/v1/shipments" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().message, "Internal Server Error");
    assert.doesNotMatch(
      response.body,
      /EX-11|execution_order_id|execution_no|SELECT/u,
    );
  } finally { await malformed.close(); }
});
