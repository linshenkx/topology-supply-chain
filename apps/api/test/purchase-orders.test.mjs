import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerPurchaseOrdersModule } from "../dist/modules/purchase-orders/index.js";

function orderRow(id) {
  return {
    id,
    orderNo: `PO-${id}`,
    source: "lingxing_excel",
    sourceFileKey: null,
    status: "factory_confirmation",
    orderDate: "2026-08-11",
    totalTaxIncludedMinor: 10_000 * id,
    paymentTermId: null,
    createdAt: `2026-08-${12 - id}T00:00:00.000Z`,
    updatedAt: `2026-08-${12 - id}T00:00:00.000Z`,
  };
}

function itemRow(id, purchaseOrderId) {
  return {
    id,
    purchaseOrderId,
    sku: `SKU-${id}`,
    productName: `Product ${id}`,
    itemType: "finished",
    supplierId: null,
    quantity: 10,
    unitPriceTaxIncludedMinor: 100,
    amountTaxIncludedMinor: 1_000,
    dueDate: "2026-09-01",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function planItemRow(id, factoryId) {
  return {
    id,
    purchasePlanId: 100 + id,
    expectedArrivalDate: "2026-09-01",
    factoryId,
    warehouseId: 20,
    sku: `SKU-${id}`,
    productName: `Product ${id}`,
    bomId: 200 + id,
    plannedQuantity: 100,
    orderedQuantity: 10,
    overToleranceBps: 500,
    underToleranceBps: 300,
    completionStatus: "not_ordered",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function linkRow(id, orderItemId, purchasePlanItemId, allocatedQuantity = 10) {
  return {
    id,
    purchasePlanItemId,
    orderItemId,
    allocatedQuantity,
    matchMethod: "manual",
    confirmedBy: 11,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function fakeDatabase({
  orders = [],
  items = [],
  links = [],
  planItems = [],
  reminders = [],
  queryError,
} = {}) {
  const queries = [];
  const planItemById = new Map(planItems.map((row) => [row.id, row]));
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params: [...params] });
      if (queryError) throw queryError;
      if (sql.includes("FROM purchase_orders")) {
        const factoryId = sql.includes("authorized_plan_items.factory_id = ?")
          ? params[0]
          : null;
        if (factoryId === null) return orders;
        return orders.filter((order) =>
          items.some(
            (item) =>
              item.purchaseOrderId === order.id &&
              links.some(
                (link) =>
                  link.orderItemId === item.id &&
                  planItemById.get(link.purchasePlanItemId)?.factoryId ===
                    factoryId,
              ),
          ),
        );
      }
      if (sql.includes("FROM order_items")) {
        const factoryId = sql.includes("scoped_items.factory_id = ?")
          ? params.at(-1)
          : null;
        return items.filter((item) => {
          if (!orders.some((order) => order.id === item.purchaseOrderId)) {
            return false;
          }
          if (factoryId === null) return true;
          return links.some(
            (link) =>
              link.orderItemId === item.id &&
              planItemById.get(link.purchasePlanItemId)?.factoryId === factoryId,
          );
        });
      }
      if (sql.includes("FROM purchase_plan_order_links")) {
        const factoryId = sql.includes("scoped_items.factory_id = ?")
          ? params.at(-1)
          : null;
        return links.filter(
          (link) =>
            params.includes(link.orderItemId) &&
            (factoryId === null ||
              planItemById.get(link.purchasePlanItemId)?.factoryId === factoryId),
        );
      }
      if (sql.includes("FROM purchase_plan_items")) {
        return planItems.filter((row) => params.includes(row.id));
      }
      if (sql.includes("FROM reminder_schedules")) {
        return reminders.filter((row) => params.includes(row.entityId));
      }
      throw new Error("Unexpected SQL");
    },
    async execute() {
      throw new Error("Purchase orders GET must not execute writes");
    },
  };
}

async function createApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerPurchaseOrdersModule(app, {
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

test("full access receives bounded orders, details, plan links, and the latest active reminder", async (t) => {
  const database = fakeDatabase({
    orders: [orderRow(2), orderRow(1)],
    items: [itemRow(20, 2), itemRow(10, 1)],
    links: [linkRow(200, 20, 2000), linkRow(100, 10, 1000)],
    planItems: [planItemRow(2000, 8), planItemRow(1000, 7)],
    reminders: [
      { entityId: 1, dueAt: "2026-08-12T00:00:00.000Z" },
      { entityId: 2, dueAt: "2026-08-13T00:00:00.000Z" },
    ],
  });
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-orders",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body.orders.map((order) => order.id), [2, 1]);
  assert.equal(body.orders[0].items[0].planLinks[0].planItem.factoryId, 8);
  assert.equal(body.orders[1].items[0].planLinks[0].allocatedQuantity, 10);
  assert.equal(body.orders[1].confirmationDueAt, "2026-08-12T00:00:00.000Z");

  assert.match(
    database.queries[0].sql,
    /ORDER BY created_at DESC, id DESC\s+LIMIT 200$/u,
  );
  const reminderQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM reminder_schedules"),
  );
  assert.match(reminderQuery.sql, /ROW_NUMBER\(\) OVER/u);
  assert.match(reminderQuery.sql, /ORDER BY created_at DESC, id DESC/u);
  assert.deepEqual(reminderQuery.params, [
    "purchase_order",
    "purchase_order_confirmation",
    "active",
    2,
    1,
  ]);

  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/purchase-orders"]?.get);
  assert.equal(openapi.components.schemas.PurchaseOrders.properties.orders.maxItems, 200);
});

test("factory scope closes multi-factory order details and plan links to its own factory", async (t) => {
  const database = fakeDatabase({
    orders: [orderRow(2), orderRow(1)],
    items: [itemRow(20, 2), itemRow(10, 1), itemRow(11, 1)],
    links: [
      linkRow(200, 20, 2000),
      linkRow(100, 10, 1000, 4),
      linkRow(101, 11, 1001, 10),
      linkRow(102, 10, 1001, 4),
      linkRow(103, 10, 1002, 2),
    ],
    planItems: [
      planItemRow(2000, 8),
      planItemRow(1000, 7),
      planItemRow(1001, 8),
      planItemRow(1002, 7),
    ],
    reminders: [
      { entityId: 1, dueAt: "2026-08-12T00:00:00.000Z" },
      { entityId: 2, dueAt: "2026-08-13T00:00:00.000Z" },
    ],
  });
  const app = await createApp({
    database,
    context: { factoryId: 7, localPreview: false, roles: ["factory"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-orders",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.orders.map((order) => order.id), [1]);
  assert.deepEqual(body.orders[0].items.map((item) => item.id), [10]);
  assert.equal(body.orders[0].items[0].quantity, 6);
  assert.equal(body.orders[0].items[0].amountTaxIncludedMinor, 600);
  assert.equal(body.orders[0].totalTaxIncludedMinor, 600);
  assert.deepEqual(
    body.orders[0].items[0].planLinks.map((link) => link.planItem.factoryId),
    [7, 7],
  );
  const orderQuery = database.queries[0];
  assert.match(orderQuery.sql, /FROM order_items AS authorized_items/u);
  assert.match(
    orderQuery.sql,
    /authorized_items\.purchase_order_id = purchase_orders\.id/u,
  );
  assert.match(orderQuery.sql, /authorized_plan_items\.factory_id = \?/u);
  assert.match(
    orderQuery.sql,
    /WHERE EXISTS[\s\S]+ORDER BY created_at DESC, id DESC\s+LIMIT 200$/u,
  );
  assert.deepEqual(orderQuery.params, [7]);
  const itemQuery = database.queries.find(({ sql }) =>
    sql.includes("amount_tax_included_minor AS amountTaxIncludedMinor"),
  );
  assert.match(itemQuery.sql, /EXISTS/u);
  assert.deepEqual(itemQuery.params, [1, 7]);
  const linkQuery = database.queries.find(({ sql }) =>
    sql.includes("links.allocated_quantity AS allocatedQuantity"),
  );
  assert.match(linkQuery.sql, /scoped_items\.factory_id = \?/u);
  assert.deepEqual(linkQuery.params, [10, 7]);
});

test("internal roles retain complete shared items, links, quantities, and order totals", async (t) => {
  const database = fakeDatabase({
    orders: [orderRow(1)],
    items: [itemRow(10, 1)],
    links: [linkRow(100, 10, 1000, 4), linkRow(101, 10, 1001, 6)],
    planItems: [planItemRow(1000, 7), planItemRow(1001, 8)],
  });
  const app = await createApp({
    database,
    context: { factoryId: 7, localPreview: false, roles: ["admin"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/purchase-orders",
  });

  assert.equal(response.statusCode, 200);
  const order = response.json().orders[0];
  assert.equal(order.items[0].quantity, 10);
  assert.equal(order.items[0].amountTaxIncludedMinor, 1_000);
  assert.equal(order.totalTaxIncludedMinor, 10_000);
  assert.deepEqual(
    order.items[0].planLinks.map((link) => link.planItem.factoryId),
    [7, 8],
  );
  assert.doesNotMatch(database.queries[0].sql, /authorized_plan_items/u);
  assert.deepEqual(database.queries[0].params, []);
});

test("supply chain retains full read access even with a factory binding", async (t) => {
  const database = fakeDatabase();
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
    url: "/api/v1/purchase-orders",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { orders: [] });
  assert.equal(database.queries.length, 1);
  assert.doesNotMatch(database.queries[0].sql, /authorized_plan_items/u);
  assert.deepEqual(database.queries[0].params, []);
});

test("factory users without a binding and unrelated roles are forbidden before database access", async () => {
  for (const context of [
    { factoryId: null, localPreview: false, roles: ["factory"] },
    { factoryId: -1, localPreview: false, roles: ["factory"] },
    { factoryId: null, localPreview: false, roles: ["finance"] },
  ]) {
    const database = fakeDatabase();
    const app = await createApp({ context, database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/purchase-orders",
      });
      assert.equal(response.statusCode, 403, JSON.stringify(context));
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
    url: "/api/v1/purchase-orders",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { orders: [], preview: true });
  assertPrivateNoStore(response);
});

test("orphan plan links and database errors fail closed without leaking details", async () => {
  const malformed = fakeDatabase({
    orders: [orderRow(1)],
    items: [itemRow(10, 1)],
    links: [linkRow(100, 10, 9999)],
    planItems: [],
  });
  const failed = fakeDatabase({
    queryError: new Error("mysql://root:secret@database/purchase_orders"),
  });

  for (const database of [malformed, failed]) {
    const app = await createApp({ database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/purchase-orders",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /mysql|root|secret|9999|purchase_orders/iu);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
