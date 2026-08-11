import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerPurchasePlansModule } from "../dist/modules/purchase-plans/index.js";

function planRow(id, version = 1) {
  return {
    id,
    planNo: "PLAN-001",
    version,
    source: "lingxing_excel",
    sourceFileKey: null,
    status: version === 1 ? "superseded" : "awaiting_factory_confirmation",
    confirmationDueAt: "2026-08-14T00:00:00.000Z",
    confirmedAt: null,
    createdBy: 11,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: `2026-08-${10 + version}T00:00:00.000Z`,
    updatedAt: `2026-08-${10 + version}T00:00:00.000Z`,
  };
}

function itemRow(id, purchasePlanId, factoryId, warehouseId = 20) {
  return {
    id,
    purchasePlanId,
    expectedArrivalDate: "2026-09-01",
    factoryId,
    warehouseId,
    sku: `SKU-${id}`,
    productName: `Product ${id}`,
    bomId: 100 + id,
    plannedQuantity: 100,
    orderedQuantity: 20,
    overToleranceBps: 500,
    underToleranceBps: 300,
    completionStatus: "not_ordered",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function responseRow(id, purchasePlanId, factoryId) {
  return {
    id,
    purchasePlanId,
    factoryId,
    decision: "confirmed",
    expectedStartDate: "2026-08-15",
    expectedFinishDate: "2026-08-25",
    proposedArrivalDate: null,
    reason: "",
    status: "accepted",
    respondedBy: 30 + factoryId,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function fakeDatabase({
  plans = [],
  items = [],
  factories = [],
  warehouses = [],
  responses = [],
  queryError,
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params: [...params] });
      if (queryError) throw queryError;
      if (sql.includes("FROM purchase_plans")) return plans;
      if (sql.includes("FROM purchase_plan_items")) {
        const scopedFactory = /AND factory_id = \?/u.test(sql)
          ? params.at(-1)
          : null;
        return items.filter(
          (row) =>
            plans.some((plan) => plan.id === row.purchasePlanId) &&
            (scopedFactory === null || row.factoryId === scopedFactory),
        );
      }
      if (sql.includes("FROM factories")) {
        return factories.filter((row) => params.includes(row.id));
      }
      if (sql.includes("FROM warehouses")) {
        return warehouses.filter((row) => params.includes(row.id));
      }
      if (sql.includes("FROM factory_plan_responses")) {
        const allowedPairs = new Set(
          Array.from({ length: params.length / 2 }, (_, index) =>
            `${params[index * 2]}:${params[index * 2 + 1]}`,
          ),
        );
        return responses.filter(
          (row) => allowedPairs.has(`${row.purchasePlanId}:${row.factoryId}`),
        );
      }
      throw new Error("Unexpected SQL");
    },
    async execute() {
      throw new Error("Purchase plans GET must not execute writes");
    },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerPurchasePlansModule(app, {
    authenticate: async () =>
      context ?? {
        factoryId: null,
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

test("full access preserves plan versions, multi-factory items, and latest responses", async (t) => {
  const plans = [planRow(2, 2), planRow(1, 1)];
  const database = fakeDatabase({
    plans,
    items: [itemRow(10, 2, 7), itemRow(11, 2, 8), itemRow(12, 1, 7)],
    factories: [{ id: 7, name: "Factory Seven" }],
    warehouses: [{ id: 20, name: "Central Warehouse" }],
    responses: [
      responseRow(101, 1, 7),
      responseRow(102, 2, 7),
      responseRow(103, 2, 8),
      responseRow(104, 1, 8),
    ],
  });
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-plans",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body.plans.map((plan) => plan.version), [2, 1]);
  assert.deepEqual(body.plans[0].items.map((item) => item.factoryId), [7, 8]);
  assert.equal(body.plans[0].items[0].factoryName, "Factory Seven");
  assert.equal(body.plans[0].items[1].factoryName, "工厂#8");
  assert.equal(body.plans[0].items[0].warehouseName, "Central Warehouse");
  assert.deepEqual(body.plans[0].responses.map((row) => row.factoryId), [7, 8]);

  assert.match(
    database.queries[0].sql,
    /ORDER BY created_at DESC, id DESC\s+LIMIT 200$/u,
  );
  assert.match(
    database.queries[1].sql,
    /ORDER BY purchase_plan_id ASC, id ASC\s+LIMIT 2001$/u,
  );
  const responseQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM factory_plan_responses"),
  );
  assert.match(responseQuery.sql, /ROW_NUMBER\(\) OVER/u);
  assert.match(responseQuery.sql, /ORDER BY created_at DESC, id DESC/u);
  assert.match(responseQuery.sql, /\(purchase_plan_id, factory_id\) IN/u);
  assert.deepEqual(responseQuery.params, [2, 7, 2, 8, 1, 7]);

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/purchase-plans"]?.get);
  assert.equal(openapi.components.schemas.PurchasePlans.properties.plans.maxItems, 200);
});

test("factory scope returns only its items and response across visible plan versions", async (t) => {
  const plans = [planRow(2, 2), planRow(1, 1)];
  const database = fakeDatabase({
    plans,
    items: [itemRow(10, 2, 7), itemRow(11, 2, 8), itemRow(12, 1, 8)],
    factories: [{ id: 7, name: "Factory Seven" }],
    warehouses: [{ id: 20, name: "Central Warehouse" }],
    responses: [responseRow(102, 2, 7), responseRow(103, 2, 8)],
  });
  const app = await createApp({
    database,
    context: { factoryId: 7, localPreview: false, roles: ["factory"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-plans",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.plans.map((plan) => plan.id), [2]);
  assert.deepEqual(body.plans[0].items.map((item) => item.factoryId), [7]);
  assert.deepEqual(body.plans[0].responses.map((row) => row.factoryId), [7]);
  assert.match(database.queries[1].sql, /AND factory_id = \?/u);
  assert.deepEqual(database.queries[1].params, [2, 1, 7]);
});

test("supply chain retains full read access even with a factory binding", async (t) => {
  const database = fakeDatabase({
    plans: [planRow(1, 1)],
    items: [itemRow(10, 1, 7), itemRow(11, 1, 8)],
    factories: [
      { id: 7, name: "Factory Seven" },
      { id: 8, name: "Factory Eight" },
    ],
    warehouses: [{ id: 20, name: "Central Warehouse" }],
    responses: [responseRow(101, 1, 7), responseRow(102, 1, 8)],
  });
  const app = await createApp({
    database,
    context: {
      factoryId: 7,
      localPreview: false,
      roles: ["supply_chain"],
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-plans",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().plans[0].items.map((item) => item.factoryId),
    [7, 8],
  );
  assert.doesNotMatch(database.queries[1].sql, /AND factory_id = \?/u);
  assert.deepEqual(database.queries[1].params, [1]);
});

test("unauthorized roles and factory users without a valid binding fail before database access", async () => {
  for (const context of [
    { factoryId: null, localPreview: false, roles: ["finance"] },
    { factoryId: null, localPreview: false, roles: ["factory"] },
    { factoryId: 0, localPreview: false, roles: ["factory"] },
  ]) {
    const database = fakeDatabase();
    const app = await createApp({ context, database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/purchase-plans",
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

test("local preview preserves the legacy empty response without a database", async (t) => {
  const app = await createApp({
    context: { factoryId: null, localPreview: true, roles: ["admin"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-plans",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { plans: [], preview: true });
  assertPrivateNoStore(response);
});

test("database failures and malformed scoped rows fail closed with a sanitized 503", async () => {
  const cases = [
    fakeDatabase({
      plans: [planRow(1, 1)],
      queryError: new Error("mysql://root:secret@database/purchase_plans"),
    }),
    {
      ...fakeDatabase({ plans: [planRow(1, 1)] }),
      async query(sql, params = []) {
        this.queries.push({ sql, params: [...params] });
        if (sql.includes("FROM purchase_plans")) return [planRow(1, 1)];
        if (sql.includes("FROM purchase_plan_items")) {
          return [itemRow(1, 999, 7)];
        }
        return [];
      },
    },
  ];

  for (const database of cases) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/purchase-plans",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /mysql|root|secret|999|purchase_plans/iu);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
