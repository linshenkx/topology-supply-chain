import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerProductionOrdersModule } from "../dist/modules/production-orders/index.js";

function orderRow(id, factoryId, orderItemId, overrides = {}) {
  return {
    id,
    executionNo: `MO-${id}`,
    orderItemId,
    factoryId,
    bomId: 1,
    plannedQuantity: 100,
    completedQuantity: 0,
    status: "planned",
    plannedStartDate: "2026-08-12",
    plannedFinishDate: null,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
    ...overrides,
  };
}

function itemRow(id, sku, overrides = {}) {
  return {
    id,
    purchaseOrderId: 1,
    sku,
    productName: `Product ${id}`,
    itemType: "finished",
    supplierId: 8,
    quantity: 100,
    unitPriceTaxIncludedMinor: 1_000,
    amountTaxIncludedMinor: 100_000,
    dueDate: "2026-08-31",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
    ...overrides,
  };
}

function purchaseRow(id = 1) {
  return {
    id,
    orderNo: `PO-${id}`,
    source: "lingxing_excel",
    sourceFileKey: "private/import.xlsx",
    status: "confirmed",
    orderDate: "2026-08-01",
    totalTaxIncludedMinor: 100_000,
    paymentTermId: 9,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function factoryRow(id, status = "active") {
  return {
    id,
    name: `Factory ${id}`,
    code: `F-${id}`,
    status,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function bomRow(id, finishedSku, overrides = {}) {
  return {
    id,
    finishedSku,
    version: `V${id}`,
    approvalStatus: "approved",
    active: 1,
    reviewedBy: 11,
    reviewedAt: "2026-08-02 10:00:00",
    createdBy: 7,
    createdAt: "2026-01-01 10:00:00",
    updatedAt: "2026-01-01 10:00:00",
    ...overrides,
  };
}

function materialRow(id, executionOrderId, bomComponentId = 10) {
  return {
    id,
    executionOrderId,
    bomComponentId,
    theoreticalQuantity: 100,
    issuedQuantity: 90,
    consumedQuantity: 80,
    lossQuantity: 10,
    deviationStatus: "within_tolerance",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function reportRow(executionOrderId) {
  return {
    executionOrderId,
    actualFinishedQuantity: 95,
    result: "underproduction_pending",
    reviewedBy: null,
    reportedBy: 9,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function baseFixture(overrides = {}) {
  return {
    orders: [orderRow(300, 1, 1), orderRow(1, 2, 4, { bomId: null })],
    items: [
      itemRow(1, "SKU-USED"),
      itemRow(2, "SKU-A"),
      itemRow(3, "SKU-B"),
      itemRow(4, "SKU-C"),
      itemRow(5, "SKU-D"),
    ],
    links: [
      { orderItemId: 2, purchasePlanItemId: 101, allocatedQuantity: 40 },
      { orderItemId: 2, purchasePlanItemId: 102, allocatedQuantity: 15 },
      { orderItemId: 2, purchasePlanItemId: 201, allocatedQuantity: 999 },
      { orderItemId: 3, purchasePlanItemId: 201, allocatedQuantity: 70 },
      { orderItemId: 4, purchasePlanItemId: 101, allocatedQuantity: 60 },
    ],
    planItems: [
      { id: 101, factoryId: 1 },
      { id: 102, factoryId: 1 },
      { id: 201, factoryId: 2 },
    ],
    purchases: [purchaseRow()],
    factories: [factoryRow(1), factoryRow(2)],
    boms: [
      bomRow(1, "SKU-USED", { approvalStatus: "pending", active: 0 }),
      bomRow(2, "SKU-A"),
      bomRow(3, "SKU-B"),
      bomRow(4, "SKU-A", { approvalStatus: "pending" }),
      bomRow(5, "SKU-A", { active: 0 }),
      bomRow(6, "SKU-D"),
    ],
    materials: [materialRow(20, 300)],
    components: [
      {
        id: 10,
        componentSku: "COMP-10",
        componentName: null,
        itemType: "component",
        quantityPerFinished: 1,
      },
    ],
    reports: [reportRow(300)],
    leakUnauthorizedBoms: false,
    ...overrides,
  };
}

function applySqlLimit(rows, sql) {
  const match = sql.match(/LIMIT (\d+)\s*$/u);
  return match ? rows.slice(0, Number(match[1])) : rows;
}

function fakeDatabase(input = {}) {
  const fixture = baseFixture(input);
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params: [...params] });
      if (sql.includes("FROM execution_orders AS orders")) {
        const selected = sql.includes("WHERE orders.factory_id = ?")
          ? fixture.orders.filter((row) => row.factoryId === params[0])
          : fixture.orders;
        return applySqlLimit([...selected].sort((a, b) => b.id - a.id), sql);
      }
      if (sql.includes("FROM order_items AS items")) {
        if (sql.includes("WHERE items.id IN")) {
          return applySqlLimit(
            fixture.items.filter((row) => params.includes(row.id)),
            sql,
          );
        }
        const usedIds = new Set(fixture.orders.map((row) => row.orderItemId));
        if (sql.includes("purchase_plan_order_links AS links")) {
          const factoryId = params[1];
          const planById = new Map(fixture.planItems.map((row) => [row.id, row]));
          const selected = fixture.items
            .filter((row) => row.itemType === params[0] && !usedIds.has(row.id))
            .map((row) => {
              const ownLinks = fixture.links.filter(
                (link) =>
                  link.orderItemId === row.id &&
                  planById.get(link.purchasePlanItemId)?.factoryId === factoryId,
              );
              return ownLinks.length === 0
                ? null
                : {
                    ...row,
                    authorizedFactoryId: factoryId,
                    quantity: ownLinks.reduce(
                      (sum, link) => sum + link.allocatedQuantity,
                      0,
                    ),
                  };
            })
            .filter((row) => row !== null)
            .sort((a, b) => a.id - b.id);
          return applySqlLimit(selected, sql);
        }
        return applySqlLimit(
          fixture.items
            .filter((row) => row.itemType === params[0] && !usedIds.has(row.id))
            .sort((a, b) => a.id - b.id),
          sql,
        );
      }
      if (sql.includes("FROM purchase_orders AS purchases")) {
        return applySqlLimit(
          fixture.purchases.filter((row) => params.includes(row.id)),
          sql,
        );
      }
      if (sql.includes("FROM factories")) {
        const selected = sql.includes("WHERE factories.id IN")
          ? fixture.factories.filter((row) => params.includes(row.id))
          : fixture.factories.filter((row) => row.status === params[0]);
        return applySqlLimit(selected.sort((a, b) => a.id - b.id), sql);
      }
      if (sql.includes("FROM product_boms AS boms")) {
        if (sql.includes("WHERE boms.id IN")) {
          return applySqlLimit(
            fixture.boms.filter((row) => params.includes(row.id)),
            sql,
          );
        }
        const allowedSkus = new Set(params.slice(2));
        const selected = fixture.boms.filter(
          (row) =>
            row.approvalStatus === params[0] &&
            row.active === params[1] &&
            (fixture.leakUnauthorizedBoms || allowedSkus.has(row.finishedSku)),
        );
        return applySqlLimit(selected.sort((a, b) => a.id - b.id), sql);
      }
      if (sql.includes("FROM production_material_lines AS materials")) {
        return applySqlLimit(
          fixture.materials.filter((row) => params.includes(row.executionOrderId)),
          sql,
        );
      }
      if (sql.includes("FROM production_reports AS reports")) {
        return applySqlLimit(
          fixture.reports.filter((row) => params.includes(row.executionOrderId)),
          sql,
        );
      }
      if (sql.includes("FROM bom_components AS components")) {
        return applySqlLimit(
          fixture.components.filter((row) => params.includes(row.id)),
          sql,
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async execute() {
      throw new Error("production-orders GET must not execute writes");
    },
  };
}

async function createApp({ audit, context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerProductionOrdersModule(app, {
    authenticate: async () =>
      context ?? {
        userId: 7,
        factoryId: null,
        localPreview: false,
        roles: ["admin"],
      },
    ...(database === undefined ? {} : { database }),
    ...(audit === undefined ? {} : { audit }),
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("factory inject scopes SQL before LIMIT, sums own allocation, closes BOMs, and emits the minimum DTO", async (t) => {
  const database = fakeDatabase();
  const audits = [];
  const app = await createApp({
    context: {
      userId: 9,
      factoryId: 1,
      localPreview: false,
      roles: ["factory"],
    },
    database,
    audit: async (event) => audits.push(event),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/production-orders" });
  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body.orders, [
    {
      id: 300,
      executionNo: "MO-300",
      plannedQuantity: 100,
      completedQuantity: 0,
      status: "planned",
      plannedStartDate: "2026-08-12",
      plannedFinishDate: null,
      item: { sku: "SKU-USED", productName: "Product 1" },
      purchaseOrder: { orderNo: "PO-1" },
      factory: { name: "Factory 1" },
      bom: { version: "V1" },
      materials: [
        {
          id: 20,
          theoreticalQuantity: 100,
          issuedQuantity: 90,
          consumedQuantity: 80,
          lossQuantity: 10,
          deviationStatus: "within_tolerance",
          component: { componentSku: "COMP-10", componentName: null },
        },
      ],
      reports: [
        { actualFinishedQuantity: 95, result: "underproduction_pending" },
      ],
    },
  ]);
  assert.deepEqual(body.options, {
    orderItems: [
      {
        id: 2,
        sku: "SKU-A",
        productName: "Product 2",
        quantity: 55,
        purchaseOrder: { orderNo: "PO-1" },
      },
    ],
    factories: [{ id: 1, name: "Factory 1" }],
    boms: [{ id: 2, finishedSku: "SKU-A", version: "V2" }],
  });

  const orderQuery = database.queries[0];
  assert.ok(orderQuery.sql.indexOf("WHERE orders.factory_id = ?") < orderQuery.sql.indexOf("LIMIT 200"));
  assert.deepEqual(orderQuery.params, [1]);
  const optionItemIndex = database.queries.findIndex(({ sql }) =>
    sql.includes("purchase_plan_order_links AS links"),
  );
  const optionItemQuery = database.queries[optionItemIndex];
  const itemLimit = optionItemQuery.sql.lastIndexOf("LIMIT 1000");
  assert.ok(optionItemQuery.sql.indexOf("plan_items.factory_id = ?") < itemLimit);
  assert.ok(optionItemQuery.sql.indexOf("NOT EXISTS") < itemLimit);
  assert.match(optionItemQuery.sql, /SUM\(links\.allocated_quantity\) AS quantity/u);
  assert.deepEqual(optionItemQuery.params, ["finished", 1]);
  const optionBomIndex = database.queries.findIndex(({ sql }) =>
    sql.includes("boms.finished_sku IN"),
  );
  const optionBomQuery = database.queries[optionBomIndex];
  assert.ok(optionBomIndex > optionItemIndex);
  assert.ok(optionBomQuery.sql.indexOf("boms.approval_status = ?") < optionBomQuery.sql.indexOf("LIMIT 500"));
  assert.ok(optionBomQuery.sql.indexOf("boms.finished_sku IN (?)") < optionBomQuery.sql.indexOf("LIMIT 500"));
  assert.deepEqual(optionBomQuery.params, ["approved", 1, "SKU-A"]);

  const serialized = JSON.stringify(body);
  for (const forbidden of [
    "supplierId", "sourceFileKey", "paymentTermId", "reviewedBy",
    "reviewedAt", "createdBy", "createdAt", "updatedAt",
    "unitPriceTaxIncludedMinor", "amountTaxIncludedMinor",
    "totalTaxIncludedMinor", "approvalStatus", "active", "options.skus",
    "purchaseOrderId", "orderItemId", "factoryId", "bomId",
    "executionOrderId", "bomComponentId", "authorizedFactoryId",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`, "u"));
  }
  assert.equal("skus" in body.options, false);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    {
      action: audits[0].action,
      module: audits[0].module,
      entityType: audits[0].entityType,
      entityId: audits[0].entityId,
      userId: audits[0].access.userId,
    },
    {
      action: "view",
      module: "production",
      entityType: "execution_order_list",
      entityId: "latest",
      userId: 9,
    },
  );
});

test("an item used by any execution order is excluded even when that order is outside the latest 200", async (t) => {
  const recent = Array.from({ length: 200 }, (_, index) =>
    orderRow(1_000 - index, 2, 1_000 + index, { bomId: null }),
  );
  const database = fakeDatabase({
    orders: [...recent, orderRow(1, 2, 4, { bomId: null })],
    materials: [],
    reports: [],
  });
  const app = await createApp({
    context: { userId: 9, factoryId: 1, localPreview: false, roles: ["factory"] },
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/production-orders" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().options.orderItems.map((row) => row.id), [2]);
  const optionSql = database.queries.find(({ sql }) =>
    sql.includes("purchase_plan_order_links AS links"),
  ).sql;
  assert.match(optionSql, /FROM execution_orders AS used_orders/u);
  assert.doesNotMatch(optionSql, /used_orders[\s\S]*LIMIT 200/u);
});

test("internal roles retain full order scope but BOM options still close over unused finished-item SKUs", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
    const database = fakeDatabase();
    const app = await createApp({
      context: { userId: 7, factoryId: null, localPreview: false, roles: [role] },
      database,
      audit: async () => undefined,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/production-orders" });
      assert.equal(response.statusCode, 200, role);
      assert.deepEqual(response.json().orders.map((row) => row.id), [300, 1]);
      assert.deepEqual(response.json().options.orderItems.map((row) => row.id), [2, 3, 5]);
      assert.deepEqual(response.json().options.boms.map((row) => row.id), [2, 3, 6]);
      assert.deepEqual(response.json().options.factories.map((row) => row.id), [1, 2]);
      assert.doesNotMatch(database.queries[0].sql, /WHERE orders\.factory_id/u);
    } finally {
      await app.close();
    }
  }
});

test("BOM SKU filtering happens before LIMIT so unrelated rows cannot evict an authorized candidate", async (t) => {
  const irrelevant = Array.from({ length: 500 }, (_, index) =>
    bomRow(index + 1, `OTHER-${index + 1}`),
  );
  const database = fakeDatabase({
    orders: [],
    items: [itemRow(10, "SKU-TARGET")],
    links: [{ orderItemId: 10, purchasePlanItemId: 101, allocatedQuantity: 23 }],
    boms: [...irrelevant, bomRow(501, "SKU-TARGET")],
    materials: [],
    reports: [],
  });
  const app = await createApp({
    context: { userId: 9, factoryId: 1, localPreview: false, roles: ["factory"] },
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/v1/production-orders" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().options.orderItems[0].quantity, 23);
  assert.deepEqual(response.json().options.boms, [
    { id: 501, finishedSku: "SKU-TARGET", version: "V501" },
  ]);
});

test("invalid factory scope is forbidden before database and preview keeps the narrowed envelope", async () => {
  for (const factoryId of [null, 0, -1, 1.5]) {
    const database = fakeDatabase();
    const app = await createApp({
      context: { userId: 9, factoryId, localPreview: false, roles: ["factory"] },
      database,
      audit: async () => assert.fail("audit must not run"),
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/production-orders" });
      assert.equal(response.statusCode, 403, String(factoryId));
      assert.equal(database.queries.length, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }

  const preview = await createApp({
    context: { userId: 0, factoryId: null, localPreview: true, roles: ["admin"] },
  });
  try {
    const response = await preview.inject({ method: "GET", url: "/api/v1/production-orders" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      orders: [],
      options: { orderItems: [], factories: [], boms: [] },
      preview: true,
    });
    assertPrivateNoStore(response);
  } finally {
    await preview.close();
  }
});

test("missing ports, malformed closure data, overflow, and audit failures fail closed", async () => {
  const cases = [
    { database: undefined, audit: async () => undefined },
    { database: fakeDatabase(), audit: undefined },
    {
      database: fakeDatabase({
        orders: [orderRow(300, 1, 1, { plannedQuantity: -1 })],
      }),
      audit: async () => undefined,
    },
    {
      database: fakeDatabase({
        materials: Array.from({ length: 2_001 }, (_, index) =>
          materialRow(index + 1, 300),
        ),
      }),
      audit: async () => undefined,
    },
    {
      database: fakeDatabase({ leakUnauthorizedBoms: true }),
      context: {
        userId: 9,
        factoryId: 1,
        localPreview: false,
        roles: ["factory"],
      },
      audit: async () => undefined,
    },
    {
      database: fakeDatabase(),
      audit: async () => {
        throw new Error("audit credential leaked");
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const app = await createApp(fixture);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/production-orders",
        headers: { "x-request-id": `production-failure-${index}` },
      });
      assert.equal(response.statusCode, 503, String(index));
      assert.equal(response.json().message, "Internal Server Error");
      assert.doesNotMatch(
        response.body,
        /audit credential|Production orders unavailable|SELECT/u,
      );
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});
