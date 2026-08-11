import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeApp } from "../dist/runtime.js";

const development = {
  APP_ENV: "development",
  DEPLOY_TARGET: "local",
  NODE_ENV: "development",
};
const production = {
  APP_ENV: "production",
  DEPLOY_TARGET: "aliyun",
  NODE_ENV: "production",
};

function fakeDatabase({ pingError } = {}) {
  const calls = { close: 0, execute: 0, ping: [], query: 0 };
  return {
    calls,
    async query() {
      calls.query += 1;
      return [];
    },
    async execute() {
      calls.execute += 1;
      return { affectedRows: 0 };
    },
    async ping(options) {
      calls.ping.push(options);
      if (pingError !== undefined) throw pingError;
    },
    async close() {
      calls.close += 1;
    },
  };
}

test("local runtime exposes migrated read previews without MySQL", async (t) => {
  const app = await buildRuntimeApp({ environment: development, logger: false });
  t.after(() => app.close());

  const [
    session,
    masterData,
    finance,
    approvals,
    inventory,
    stocktakes,
    shipments,
    warehouses,
    purchasePlans,
    purchaseOrders,
    importDiff,
    users,
    auditLogs,
    notifications,
    files,
    productionOrders,
    qualityInspections,
    returns,
    suppliers,
    supplierSkus,
    supplierPrices,
    supplierPerformance,
    readiness,
  ] = await Promise.all([
    app.inject({ method: "GET", url: "/api/v1/session" }),
    app.inject({ method: "GET", url: "/api/v1/master-data" }),
    app.inject({ method: "GET", url: "/api/v1/finance" }),
    app.inject({ method: "GET", url: "/api/v1/approvals" }),
    app.inject({ method: "GET", url: "/api/v1/inventory" }),
    app.inject({ method: "GET", url: "/api/v1/stocktakes" }),
    app.inject({ method: "GET", url: "/api/v1/shipments" }),
    app.inject({ method: "GET", url: "/api/v1/warehouses" }),
    app.inject({ method: "GET", url: "/api/v1/purchase-plans" }),
    app.inject({ method: "GET", url: "/api/v1/purchase-orders" }),
    app.inject({ method: "GET", url: "/api/v1/imports/diff?batchId=1" }),
    app.inject({ method: "GET", url: "/api/v1/users" }),
    app.inject({ method: "GET", url: "/api/v1/audit-logs" }),
    app.inject({ method: "GET", url: "/api/v1/notifications" }),
    app.inject({ method: "GET", url: "/api/v1/files?id=1" }),
    app.inject({ method: "GET", url: "/api/v1/production-orders" }),
    app.inject({ method: "GET", url: "/api/v1/quality-inspections" }),
    app.inject({ method: "GET", url: "/api/v1/returns" }),
    app.inject({ method: "GET", url: "/api/v1/suppliers" }),
    app.inject({ method: "GET", url: "/api/v1/supplier-skus" }),
    app.inject({ method: "GET", url: "/api/v1/supplier-prices" }),
    app.inject({ method: "GET", url: "/api/v1/supplier-performance" }),
    app.inject({ method: "GET", url: "/api/v1/health/ready" }),
  ]);

  assert.equal(session.statusCode, 200);
  assert.equal(session.json().localPreview, true);
  assert.equal(masterData.statusCode, 200);
  assert.equal(masterData.json().preview, true);
  assert.equal(finance.statusCode, 200);
  assert.equal(finance.json().preview, true);
  assert.equal(approvals.statusCode, 200);
  assert.equal(approvals.json().preview, true);
  for (const response of [
    inventory,
    stocktakes,
    shipments,
    warehouses,
    purchasePlans,
    purchaseOrders,
    importDiff,
    users,
    notifications,
    productionOrders,
    qualityInspections,
    returns,
    suppliers,
    supplierSkus,
    supplierPrices,
    supplierPerformance,
  ]) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().preview, true);
  }
  assert.equal(auditLogs.statusCode, 200);
  assert.deepEqual(auditLogs.json(), {
    logs: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  assert.equal(files.statusCode, 404);
  assert.deepEqual(readiness.json().checks, []);
});

test("production runtime fails closed before listening when DATABASE_URL is missing", async () => {
  await assert.rejects(
    () => buildRuntimeApp({ environment: production, logger: false }),
    (error) => {
      assert.match(error.message, /^DATABASE_URL /u);
      assert.doesNotMatch(error.message, /mysql:\/\//iu);
      return true;
    },
  );
});

test("injected production database participates in readiness", async (t) => {
  const database = fakeDatabase();
  const app = await buildRuntimeApp({
    database,
    databasePingTimeoutMs: 1_500,
    environment: production,
    logger: false,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/ready",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().checks, [{ name: "mysql", status: "ok" }]);
  assert.deepEqual(database.calls.ping, [{ timeoutMs: 1_500 }]);
});

test("database readiness failures are sanitized and bounded", async (t) => {
  const database = fakeDatabase({
    pingError: new Error("mysql://root:secret@database"),
  });
  const app = await buildRuntimeApp({
    database,
    environment: production,
    logger: false,
    readinessTimeoutMs: 100,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/health/ready",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().status, "not_ready");
  assert.doesNotMatch(response.body, /mysql:\/\/|root:|secret@/iu);
});

test("runtime closes only databases that it creates", async () => {
  const injected = fakeDatabase();
  const injectedApp = await buildRuntimeApp({
    database: injected,
    environment: production,
    logger: false,
  });
  await injectedApp.close();
  assert.equal(injected.calls.close, 0);

  const owned = fakeDatabase();
  const ownedApp = await buildRuntimeApp({
    databaseFactory: () => owned,
    environment: {
      ...production,
      DATABASE_URL: "mysql://user:password@database:3306/topology",
    },
    logger: false,
  });
  await ownedApp.close();
  assert.equal(owned.calls.close, 1);
});
