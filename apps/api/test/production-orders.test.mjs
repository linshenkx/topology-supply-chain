import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import {
  registerProductionOrdersModule,
} from "../dist/modules/production-orders/index.js";

function orderRow(id, factoryId = 1, orderItemId = id) {
  return {
    id,
    executionNo: `MO-${id}`,
    orderItemId,
    factoryId,
    bomId: 1,
    plannedQuantity: 100,
    completedQuantity: 0,
    status: "planned",
    dueDate: "2026-08-31",
    plannedStartDate: "2026-08-12",
    plannedFinishDate: "2026-08-20",
    actualStartAt: null,
    actualFinishAt: null,
    createdAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
    updatedAt: `2026-08-${String(id).padStart(2, "0")} 10:00:00`,
  };
}

function itemRow(id, itemType = "finished") {
  return {
    id,
    purchaseOrderId: 1,
    sku: `SKU-${id}`,
    productName: `Product ${id}`,
    itemType,
    supplierId: 8,
    quantity: 100,
    unitPriceTaxIncludedMinor: 1_000,
    amountTaxIncludedMinor: 100_000,
    dueDate: "2026-08-31",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function purchaseRow(id = 1) {
  return {
    id,
    orderNo: `PO-${id}`,
    source: "lingxing_excel",
    sourceFileKey: null,
    status: "confirmed",
    orderDate: "2026-08-01",
    totalTaxIncludedMinor: 100_000,
    paymentTermId: null,
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

function bomRow(id = 1) {
  return {
    id,
    finishedSku: "SKU-1",
    version: "V1",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    overlapAllowed: 0,
    overlapReason: "",
    approvalStatus: "approved",
    reviewedBy: null,
    reviewedAt: null,
    active: 1,
    createdBy: 7,
    createdAt: "2026-01-01 10:00:00",
    updatedAt: "2026-01-01 10:00:00",
  };
}

function skuRow(id = 1) {
  return {
    id,
    code: `SKU-${id}`,
    name: `SKU ${id}`,
    itemType: "finished",
    stockUnit: "pcs",
    serialTrackingEnabled: 0,
    overproductionToleranceBps: 0,
    purchaseOverToleranceBps: 0,
    purchaseUnderToleranceBps: 0,
    verificationStatus: "approved",
    status: "active",
    createdAt: "2026-01-01 10:00:00",
    updatedAt: "2026-01-01 10:00:00",
  };
}

function materialRow(id, executionOrderId = 1) {
  return {
    id,
    executionOrderId,
    bomComponentId: id,
    theoreticalQuantity: 1,
    reservedQuantity: 0,
    issuedQuantity: 0,
    consumedQuantity: 0,
    lossQuantity: 0,
    deviationStatus: "within_tolerance",
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
  };
}

function applySqlLimit(rows, sql) {
  const match = sql.match(/LIMIT (\d+)$/u);
  return match ? rows.slice(0, Number(match[1])) : rows;
}

function fakeDatabase({
  boms = [bomRow()],
  factories = [factoryRow(1), factoryRow(2)],
  items = [itemRow(1), itemRow(2), itemRow(3)],
  materials = [],
  orders = [orderRow(2, 2, 2), orderRow(1, 1, 1)],
  purchases = [purchaseRow()],
  skus = [skuRow()],
} = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM execution_orders AS orders")) {
        if (sql.startsWith("SELECT orders.order_item_id")) {
          return applySqlLimit(
            orders.map((row) => ({ orderItemId: row.orderItemId })),
            sql,
          );
        }
        const selectedOrders = sql.includes("WHERE orders.factory_id")
          ? orders.filter((row) => row.factoryId === params[0])
          : orders;
        return applySqlLimit(selectedOrders, sql);
      }
      if (sql.includes("FROM order_items AS items")) {
        if (sql.includes("WHERE items.id IN")) {
          return applySqlLimit(
            items.filter((row) => params.includes(row.id)),
            sql,
          );
        }
        const excludedIds = new Set(params.slice(1));
        return applySqlLimit(
          items.filter(
            (row) =>
              row.itemType === params[0] && !excludedIds.has(row.id),
          ),
          sql,
        );
      }
      if (sql.includes("FROM purchase_orders AS purchases")) {
        return applySqlLimit(
          purchases.filter((row) => params.includes(row.id)),
          sql,
        );
      }
      if (sql.includes("FROM factories")) {
        const selectedFactories = sql.includes("WHERE factories.id IN")
          ? factories.filter((row) => params.includes(row.id))
          : factories.filter((row) => row.status === params[0]);
        return applySqlLimit(selectedFactories, sql);
      }
      if (sql.includes("FROM product_boms AS boms")) {
        const selectedBoms = sql.includes("WHERE boms.id IN")
          ? boms.filter((row) => params.includes(row.id))
          : boms.filter(
              (row) =>
                row.approvalStatus === params[0] &&
                row.active === params[1],
            );
        return applySqlLimit(selectedBoms, sql);
      }
      if (sql.includes("FROM skus")) return applySqlLimit(skus, sql);
      if (sql.includes("FROM production_material_lines")) {
        return applySqlLimit(materials, sql);
      }
      if (sql.includes("FROM production_reports")) return [];
      if (sql.includes("FROM bom_components")) return [];
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

test("factory scope enters SQL before LIMIT, hides other factories, and audits the read", async (t) => {
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

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/production-orders",
  });
  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  const openapi = app.swagger();
  assert.ok(openapi.paths["/api/v1/production-orders"]?.get);
  assert.equal(
    openapi.components.schemas.ProductionOrders.properties.orders.maxItems,
    200,
  );
  const body = response.json();
  assert.deepEqual(body.orders.map((row) => row.id), [1]);
  assert.deepEqual(body.options.factories.map((row) => row.id), [1]);
  assert.equal(body.orders[0].item.id, 1);
  assert.equal(body.orders[0].purchaseOrder.id, 1);
  assert.deepEqual(body.options.orderItems.map((row) => row.id), [3]);

  const orderQuery = database.queries[0];
  assert.match(orderQuery.sql, /WHERE orders\.factory_id = \?/u);
  assert.ok(
    orderQuery.sql.indexOf("WHERE orders.factory_id = ?") <
      orderQuery.sql.indexOf("LIMIT 200"),
  );
  assert.deepEqual(orderQuery.params, [1]);
  const factoryQuery = database.queries.find(({ sql }) =>
    sql.includes("WHERE factories.id IN"),
  );
  assert.match(factoryQuery.sql, /WHERE factories\.id IN \(\?\)/u);
  assert.deepEqual(factoryQuery.params, [1]);

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

test("internal roles with no factory id retain full access", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
    const database = fakeDatabase();
    const app = await createApp({
      context: {
        userId: 7,
        factoryId: null,
        localPreview: false,
        roles: [role],
      },
      database,
      audit: async () => undefined,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/production-orders",
      });
      assert.equal(response.statusCode, 200, role);
      assert.deepEqual(response.json().orders.map((row) => row.id), [2, 1]);
      assert.deepEqual(response.json().options.factories.map((row) => row.id), [1, 2]);
      assert.doesNotMatch(database.queries[0].sql, /WHERE orders\.factory_id/u);
      assert.deepEqual(database.queries[0].params, []);
    } finally {
      await app.close();
    }
  }
});

test("a factory with no production orders still receives only its own factory option", async (t) => {
  const database = fakeDatabase({ orders: [orderRow(2, 2, 2)] });
  const app = await createApp({
    context: {
      userId: 9,
      factoryId: 1,
      localPreview: false,
      roles: ["factory"],
    },
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/production-orders",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().orders, []);
  assert.deepEqual(response.json().options.factories.map((row) => row.id), [1]);
});

test("pure factory without a valid factoryId is forbidden before database or audit", async () => {
  for (const factoryId of [null, 0, -1, 1.5]) {
    const database = fakeDatabase();
    let auditCalls = 0;
    const app = await createApp({
      context: {
        userId: 9,
        factoryId,
        localPreview: false,
        roles: ["factory"],
      },
      database,
      audit: async () => {
        auditCalls += 1;
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/production-orders",
      });
      assert.equal(response.statusCode, 403, String(factoryId));
      assert.equal(response.json().code, "FORBIDDEN");
      assert.equal(database.queries.length, 0);
      assert.equal(auditCalls, 0);
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("local preview preserves the empty legacy envelope without database or audit", async (t) => {
  const app = await createApp({
    context: {
      userId: 0,
      factoryId: null,
      localPreview: true,
      roles: ["admin"],
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/production-orders",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    orders: [],
    options: { orderItems: [], factories: [], boms: [], skus: [] },
    preview: true,
  });
  assertPrivateNoStore(response);
});

test("real serializer preserves nullable production fields as null", async (t) => {
  const database = fakeDatabase({
    orders: [
      {
        ...orderRow(1, 1, 1),
        bomId: null,
        dueDate: null,
        plannedStartDate: null,
        plannedFinishDate: null,
      },
    ],
    items: [{ ...itemRow(1), supplierId: null, dueDate: null }],
    purchases: [{ ...purchaseRow(1), orderDate: null }],
    boms: [],
    skus: [{ ...skuRow(1), itemType: null, stockUnit: null }],
  });
  const app = await createApp({
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/production-orders",
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.orders[0].bomId, null);
  assert.equal(body.orders[0].dueDate, null);
  assert.equal(body.orders[0].plannedStartDate, null);
  assert.equal(body.orders[0].plannedFinishDate, null);
  assert.equal(body.orders[0].actualStartAt, null);
  assert.equal(body.orders[0].actualFinishAt, null);
  assert.equal(body.orders[0].item.supplierId, null);
  assert.equal(body.orders[0].item.dueDate, null);
  assert.equal(body.orders[0].purchaseOrder.sourceFileKey, null);
  assert.equal(body.orders[0].purchaseOrder.orderDate, null);
  assert.equal(body.orders[0].purchaseOrder.paymentTermId, null);
  assert.equal(body.options.skus[0].itemType, null);
  assert.equal(body.options.skus[0].stockUnit, null);
});

test("healthy master-data growth is deterministically capped instead of returning 503", async (t) => {
  const database = fakeDatabase({
    orders: [{ ...orderRow(1, 1_001, 1_502), bomId: 1_001 }],
    items: [
      ...Array.from({ length: 500 }, (_, index) =>
        itemRow(index + 1, "auxiliary"),
      ),
      ...Array.from({ length: 1_002 }, (_, index) => itemRow(index + 501)),
    ],
    factories: [
      ...Array.from({ length: 500 }, (_, index) =>
        factoryRow(index + 1, "inactive"),
      ),
      ...Array.from({ length: 501 }, (_, index) => factoryRow(index + 501)),
    ],
    boms: [
      ...Array.from({ length: 500 }, (_, index) => ({
        ...bomRow(index + 1),
        approvalStatus: "pending",
      })),
      ...Array.from({ length: 501 }, (_, index) => bomRow(index + 501)),
    ],
    skus: Array.from({ length: 501 }, (_, index) => skuRow(index + 1)),
  });
  const app = await createApp({
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/production-orders",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().orders[0].item.id, 1_502);
  assert.equal(response.json().orders[0].factory.id, 1_001);
  assert.equal(response.json().orders[0].bom.id, 1_001);
  assert.equal(response.json().options.orderItems.length, 1_000);
  assert.equal(response.json().options.orderItems[0].id, 501);
  assert.equal(response.json().options.factories.length, 500);
  assert.equal(response.json().options.factories[0].id, 501);
  assert.equal(response.json().options.boms.length, 500);
  assert.equal(response.json().options.boms[0].id, 501);
  assert.equal(response.json().options.skus.length, 500);
  assert.match(
    database.queries.find(({ sql }) =>
      sql.includes("WHERE items.item_type = ?"),
    ).sql,
    /ORDER BY items\.id ASC\s+LIMIT 1000$/u,
  );
});

test("missing ports, malformed rows, child overflow, and audit failures are sanitized", async () => {
  const cases = [
    { database: undefined, audit: async () => undefined },
    { database: fakeDatabase(), audit: undefined },
    {
      database: fakeDatabase({ orders: [{ ...orderRow(1), plannedQuantity: -1 }] }),
      audit: async () => undefined,
    },
    {
      database: fakeDatabase({
        materials: Array.from({ length: 2_001 }, (_, index) =>
          materialRow(index + 1),
        ),
      }),
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
