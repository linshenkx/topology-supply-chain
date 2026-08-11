import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { registerSuppliersModule } from "../dist/modules/suppliers/index.js";

const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");

function context(overrides = {}) {
  return {
    userId: 1,
    email: "reader@example.com",
    name: "Reader",
    roles: ["admin"],
    factoryId: null,
    supplierId: null,
    localPreview: false,
    ...overrides,
  };
}

function supplierProfileRow(id, overrides = {}) {
  return {
    id,
    code: `SUP-${id}`,
    name: `Supplier ${id}`,
    tier: 2,
    managedByFactoryId: 7,
    unifiedSocialCreditCode: `CREDIT-${id}`,
    address: `Address ${id}`,
    contactName: `Contact ${id}`,
    contactPhone: `1380000${id}`,
    businessScope: "Components",
    verificationStatus: "approved",
    status: "active",
    ...overrides,
  };
}

function supplierSummaryRow(id, overrides = {}) {
  const profile = supplierProfileRow(id, overrides);
  return {
    id: profile.id,
    code: profile.code,
    name: profile.name,
    tier: profile.tier,
    managedByFactoryId: profile.managedByFactoryId,
    status: profile.status,
  };
}

function factoryRow(id = 7) {
  return { id, code: `FAC-${id}`, name: `Factory ${id}`, status: "active" };
}

function skuRow(id = 3, code = "SKU-3") {
  return {
    id,
    code,
    name: `SKU ${id}`,
    itemType: "component",
    stockUnit: "pcs",
  };
}

function relationRow(id = 20, overrides = {}) {
  return {
    id,
    factoryId: 7,
    supplierId: 9,
    sku: "SKU-3",
    isPrimary: 1,
    priority: 1,
    minimumOrderQuantity: 10,
    packagingMultiple: 5,
    purchaseUnit: "box",
    leadTimeDays: 2,
    dailyCapacity: 10,
    monthlyCapacity: 100,
    effectiveFrom: "2026-01-01",
    status: "active",
    ...overrides,
  };
}

function agreementRow(id = 30, overrides = {}) {
  return {
    id,
    supplierId: 9,
    sku: "SKU-3",
    currency: "CNY",
    unitPriceTaxIncludedMinor: 1_130,
    unitPriceTaxExcludedMinor: 1_000,
    taxRateBps: 1_300,
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    status: "active",
    ...overrides,
  };
}

function priceRequestRow(id = 40) {
  return {
    id,
    currentAgreementId: 30,
    supplierId: 9,
    sku: "SKU-3",
    proposedTaxIncludedMinor: 1_200,
    proposedTaxExcludedMinor: 1_062,
    proposedTaxRateBps: 1_300,
    proposedEffectiveFrom: "2026-09-01",
    reason: "Material change",
    decision: "pending",
  };
}

function performanceSupplierRow(id, overrides = {}) {
  return {
    id,
    code: `SUP-${id}`,
    name: `Supplier ${id}`,
    tier: 1,
    managedByFactoryId: null,
    ...overrides,
  };
}

function reviewRow(supplierId, score, comment) {
  return {
    supplierId,
    reviewType: "sampling",
    score,
    tagsJson: JSON.stringify(["responsive"]),
    comment,
  };
}

function fakeDatabase(resolve) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return resolve(sql, params);
    },
    async execute() {
      throw new Error("supplier GET modules must not execute writes");
    },
  };
}

function fixtureDatabase(fixtures = {}) {
  return fakeDatabase((sql) => {
    if (sql.includes("FROM supplier_skus")) return fixtures.relations ?? [];
    if (sql.includes("FROM core_price_agreements")) {
      return fixtures.agreements ?? [];
    }
    if (sql.includes("FROM core_price_change_requests")) {
      return fixtures.priceRequests ?? [];
    }
    if (sql.includes("FROM order_items AS items")) return fixtures.demand ?? [];
    if (sql.includes("FROM supplier_performance_reviews")) {
      return fixtures.reviews ?? [];
    }
    if (sql.includes("FROM supplier_performance_weight_versions")) {
      return fixtures.weights ?? [];
    }
    if (sql.includes("FROM delivery_batches AS batches")) {
      return fixtures.deliveries ?? [];
    }
    if (sql.includes("FROM factories")) return fixtures.factories ?? [];
    if (sql.includes("FROM skus")) return fixtures.skus ?? [];
    if (sql.includes("FROM suppliers")) {
      if (sql.includes("unified_social_credit_code")) {
        return fixtures.supplierProfiles ?? [];
      }
      if (sql.includes("managed_by_factory_id") && sql.includes("tier IN")) {
        return fixtures.performanceSuppliers ?? [];
      }
      return fixtures.supplierSummaries ?? [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

async function createApp({
  access = context(),
  audit,
  database,
  exportPerformance,
} = {}) {
  const app = await buildApp({ logger: false });
  await registerSuppliersModule(app, {
    authenticate: async () => access,
    ...(audit === undefined ? {} : { audit }),
    ...(database === undefined ? {} : { database }),
    ...(exportPerformance === undefined ? {} : { exportPerformance }),
    now: fixedNow,
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("all four GET endpoints short-circuit to empty local preview envelopes", async (t) => {
  const app = await createApp({
    access: context({ localPreview: true }),
  });
  t.after(() => app.close());

  const expected = new Map([
    ["/api/v1/suppliers", { suppliers: [], preview: true }],
    ["/api/v1/supplier-skus", { relations: [], preview: true }],
    [
      "/api/v1/supplier-prices",
      {
        agreements: [],
        requests: [],
        suppliers: [],
        skus: [],
        relations: [],
        risks: [],
        preview: true,
      },
    ],
  ]);

  for (const [url, payload] of expected) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200, url);
    assertPrivateNoStore(response);
    assert.deepEqual(response.json(), payload);
  }

  const performance = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-performance?quarter=2026-Q3&tier=1&format=xlsx",
  });
  assert.equal(performance.statusCode, 200);
  assertPrivateNoStore(performance);
  assert.deepEqual(performance.json(), {
    quarter: "2026-Q3",
    rankings: [],
    weights: [
      {
        tier: 1,
        delivery: 2500,
        quality: 2000,
        exception: 1500,
        preparation: 1000,
        satisfaction: 1500,
        sampling: 1500,
      },
      {
        tier: 2,
        delivery: 3000,
        quality: 2500,
        exception: 1500,
        preparation: 1500,
        satisfaction: 0,
        sampling: 1500,
      },
      {
        tier: 3,
        delivery: 3000,
        quality: 2500,
        exception: 2000,
        preparation: 1000,
        satisfaction: 0,
        sampling: 1500,
      },
    ],
    canConfigure: true,
    canReview: true,
    automaticMetricsPending: true,
    preview: true,
  });
});

test("supplier profiles preserve role scopes and select only contract fields", async () => {
  const cases = [
    {
      access: context({ roles: ["finance"] }),
      expectedParams: [],
      expectedWhere: /ORDER BY updated_at DESC, id DESC\s+LIMIT 200$/u,
    },
    {
      access: context({ roles: ["factory"], factoryId: 7 }),
      expectedParams: [7],
      expectedWhere: /WHERE managed_by_factory_id = \?/u,
    },
    {
      access: context({
        roles: ["supplier_qc"],
        factoryId: 7,
        supplierId: 9,
      }),
      expectedParams: [7],
      expectedWhere: /WHERE managed_by_factory_id = \?/u,
    },
    {
      access: context({ roles: ["supplier_qc"], supplierId: 9 }),
      expectedParams: [9, "active"],
      expectedWhere: /WHERE id = \? AND status = \?/u,
    },
  ];

  for (const value of cases) {
    const database = fixtureDatabase({
      supplierProfiles: [supplierProfileRow(9)],
      factories: value.access.factoryId === null ? [] : [factoryRow(7)],
    });
    const app = await createApp({ access: value.access, database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/suppliers",
      });
      assert.equal(response.statusCode, 200, JSON.stringify(value.access));
      assertPrivateNoStore(response);
      assert.match(database.queries[0].sql, value.expectedWhere);
      assert.deepEqual(database.queries[0].params, value.expectedParams);
      const supplier = response.json().suppliers[0];
      assert.equal(supplier.contactPhone, "13800009");
      assert.equal("businessLicenseFileKey" in supplier, false);
      assert.equal("riskReason" in supplier, false);
      assert.equal("verifiedBy" in supplier, false);
    } finally {
      await app.close();
    }
  }
});

test("unscoped authenticated roles receive empty supplier data without database access", async (t) => {
  const database = fixtureDatabase();
  const app = await createApp({
    access: context({ roles: ["receiver"] }),
    database,
  });
  t.after(() => app.close());

  for (const url of ["/api/v1/suppliers", "/api/v1/supplier-skus"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 200);
    assertPrivateNoStore(response);
  }
  assert.equal(database.queries.length, 0);
});

test("supplier SKU reference data is closed over supplier-visible relations", async (t) => {
  const database = fixtureDatabase({
    relations: [relationRow()],
    supplierSummaries: [supplierSummaryRow(9)],
    factories: [factoryRow(7)],
    skus: [skuRow()],
  });
  const app = await createApp({
    access: context({ roles: ["supplier_qc"], supplierId: 9 }),
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-skus",
  });
  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json(), {
    relations: [
      {
        ...relationRow(),
        isPrimary: true,
      },
    ],
    suppliers: [supplierSummaryRow(9)],
    factories: [factoryRow(7)],
    skus: [skuRow()],
  });

  const relationQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM supplier_skus"),
  );
  assert.match(
    relationQuery.sql,
    /WHERE supplier_id = \?\s+ORDER BY id DESC\s+LIMIT 500$/u,
  );
  assert.deepEqual(relationQuery.params, [9]);
  const supplierQuery = database.queries.find(
    ({ sql }) => sql.includes("FROM suppliers") && !sql.includes("tier IN"),
  );
  assert.match(supplierQuery.sql, /WHERE id IN \(\?\)/u);
  assert.deepEqual(supplierQuery.params, [9]);
  const factoryQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM factories"),
  );
  assert.match(factoryQuery.sql, /WHERE id IN \(\?\)/u);
  assert.deepEqual(factoryQuery.params, [7]);
  const skuQuery = database.queries.find(({ sql }) => sql.includes("FROM skus"));
  assert.match(skuQuery.sql, /code IN \(\?\)/u);
  assert.deepEqual(skuQuery.params, ["active", "SKU-3"]);
});

test("factory SKU dictionaries retain managed or relation-linked candidates only", async (t) => {
  const database = fixtureDatabase({
    relations: [relationRow()],
    supplierSummaries: [supplierSummaryRow(9)],
    factories: [factoryRow(7)],
    skus: [skuRow()],
  });
  const app = await createApp({
    access: context({ roles: ["factory"], factoryId: 7 }),
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-skus",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().suppliers.length, 1);
  const supplierQuery = database.queries.find(
    ({ sql }) =>
      sql.includes("FROM suppliers") && sql.includes("managed_by_factory_id = ?"),
  );
  assert.match(
    supplierQuery.sql,
    /WHERE managed_by_factory_id = \? OR id IN \(\?\)/u,
  );
  assert.deepEqual(supplierQuery.params, [7, 9]);
  assert.equal(
    database.queries.some(
      ({ sql }) =>
        sql.includes("FROM factories") && !sql.includes("WHERE id = ?"),
    ),
    false,
  );
});

test("factory prices are scoped by active relations, calculate stable risks, and audit", async (t) => {
  const database = fixtureDatabase({
    relations: [relationRow()],
    supplierSummaries: [supplierSummaryRow(9)],
    skus: [skuRow()],
    agreements: [
      agreementRow(31, {
        effectiveFrom: "2026-08-01",
        effectiveTo: null,
      }),
      agreementRow(30, {
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        status: "inactive",
      }),
    ],
    priceRequests: [priceRequestRow()],
    demand: [
      { supplierId: 9, sku: "SKU-3", quantity: 12, dueDate: "2026-08-20" },
    ],
  });
  const audits = [];
  const app = await createApp({
    access: context({ roles: ["factory"], factoryId: 7 }),
    database,
    audit: async (event, actor) => audits.push({ event, actor }),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-prices",
  });
  assert.equal(response.statusCode, 200, response.body);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body.agreements.map(({ id }) => id), [31, 30]);
  assert.deepEqual(body.risks, [
    {
      relationId: 20,
      factoryId: 7,
      supplierId: 9,
      sku: "SKU-3",
      periodType: "day",
      period: "2026-08-20",
      demand: 12,
      capacity: 10,
      excess: 2,
    },
  ]);
  assert.equal("evidenceFileKey" in body.requests[0], false);
  assert.equal("requestedBy" in body.requests[0], false);
  assert.deepEqual(audits, [
    {
      event: {
        action: "view",
        module: "supplier_prices",
        entityType: "price_list",
        entityId: "latest",
        sensitiveView: true,
      },
      actor: {
        userId: 1,
        email: "reader@example.com",
        name: "Reader",
        roles: ["factory"],
        factoryId: 7,
        supplierId: null,
      },
    },
  ]);

  const relationQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM supplier_skus"),
  );
  assert.match(relationQuery.sql, /factory_id = \? AND status = \?/u);
  assert.deepEqual(relationQuery.params, [7, "active"]);
  const demandQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM order_items AS items"),
  );
  assert.match(
    demandQuery.sql,
    /items\.supplier_id IN \(\?\)[\s\S]*orders\.status NOT IN \(\?, \?, \?\)[\s\S]*ORDER BY items\.id DESC\s+LIMIT 5000$/u,
  );
  assert.deepEqual(demandQuery.params, [
    9,
    "completed",
    "closed",
    "cancelled",
  ]);
});

test("internal price relations are queried inside the selected supplier window", async (t) => {
  const database = fixtureDatabase({
    relations: [relationRow()],
    supplierSummaries: [supplierSummaryRow(9)],
    skus: [skuRow()],
    agreements: [agreementRow()],
  });
  const app = await createApp({
    access: context({ roles: ["finance"] }),
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-prices",
  });
  assert.equal(response.statusCode, 200, response.body);
  const relationQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM supplier_skus"),
  );
  assert.match(
    relationQuery.sql,
    /WHERE status = \?\s+AND supplier_id IN \(\?\)\s+ORDER BY id DESC\s+LIMIT 2000$/u,
  );
  assert.deepEqual(relationQuery.params, ["active", 9]);
  assert.deepEqual(response.json().relations.map(({ supplierId }) => supplierId), [
    9,
  ]);
});

test("sensitive price reads fail closed without audit and sanitize malformed validity", async () => {
  for (const { audit, database, expectedQueries } of [
    {
      database: fixtureDatabase({
        relations: [],
        supplierSummaries: [],
        skus: [],
      }),
      expectedQueries: 0,
    },
    {
      database: fixtureDatabase({
        relations: [relationRow()],
        supplierSummaries: [supplierSummaryRow(9)],
        skus: [skuRow()],
        agreements: [
          agreementRow(30, {
            effectiveFrom: "2026-08-01",
            effectiveTo: "2026-07-31",
          }),
        ],
      }),
      audit: async () => undefined,
      expectedQueries: 6,
    },
  ]) {
    const app = await createApp({
      access: context({ roles: ["factory"], factoryId: 7 }),
      database,
      ...(audit === undefined ? {} : { audit }),
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/supplier-prices",
        headers: { "x-request-id": "price-fail-closed" },
      });
      assert.equal(response.statusCode, 503);
      assertPrivateNoStore(response);
      assert.equal(response.json().code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(response.body, /core_price|effectiveTo|2026-07-31/u);
      assert.equal(database.queries.length, expectedQueries);
    } finally {
      await app.close();
    }
  }
});

test("large valid factory relation windows do not fail when summaries are capped", async (t) => {
  const relations = Array.from({ length: 501 }, (_, index) =>
    relationRow(1_000 - index, { supplierId: index + 1 }),
  );
  const database = fixtureDatabase({
    relations,
    supplierSummaries: Array.from({ length: 500 }, (_, index) =>
      supplierSummaryRow(index + 1),
    ),
    skus: [skuRow()],
    agreements: [agreementRow(30, { supplierId: 501 })],
  });
  const app = await createApp({
    access: context({ roles: ["factory"], factoryId: 7 }),
    database,
    audit: async () => undefined,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-prices",
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().relations.length, 501);
  assert.equal(response.json().suppliers.length, 500);
  assert.equal(response.json().agreements[0].supplierId, 501);
  const agreementQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM core_price_agreements"),
  );
  assert.equal(agreementQuery.params.length, 501);
  assert.ok(agreementQuery.params.includes(501));
});

test("supplier performance preserves anonymous rankings while hiding foreign comments", async (t) => {
  const database = fixtureDatabase({
    performanceSuppliers: [
      performanceSupplierRow(10),
      performanceSupplierRow(9),
    ],
    reviews: [
      reviewRow(9, 5, "Own improvement note"),
      reviewRow(10, 4, "Competitor identifying note"),
    ],
    deliveries: [],
    weights: [],
  });
  const app = await createApp({
    access: context({
      roles: ["supplier_qc"],
      supplierId: 9,
      email: "supplier@example.com",
    }),
    database,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-performance?quarter=2026-Q3&tier=1",
  });
  assert.equal(response.statusCode, 200, response.body);
  assertPrivateNoStore(response);
  const body = response.json();
  assert.deepEqual(body.rankings.map(({ supplierId }) => supplierId), [9, null]);
  assert.equal(body.rankings[0].displayName, "Supplier 9");
  assert.equal(body.rankings[0].supplierCode, "SUP-9");
  assert.deepEqual(body.rankings[0].comments, [
    {
      type: "sampling",
      comment: "Own improvement note",
      tags: ["responsive"],
    },
  ]);
  assert.equal(body.rankings[1].displayName, "第2名企业");
  assert.equal(body.rankings[1].supplierCode, null);
  assert.equal(body.rankings[1].supplierName, null);
  assert.deepEqual(body.rankings[1].comments, []);
  assert.equal(body.rankings[1].metrics.delivery, null);
  assert.equal(body.rankings[1].metrics.quality, null);
  assert.equal(body.canConfigure, false);
  assert.equal(body.canReview, false);
  assert.doesNotMatch(response.body, /Competitor identifying note/u);

  const supplierQuery = database.queries.find(
    ({ sql }) => sql.includes("FROM suppliers") && sql.includes("tier IN"),
  );
  assert.match(
    supplierQuery.sql,
    /WHERE status = \?[\s\S]*AND tier IN \(1, 2, 3\)[\s\S]*AND tier = \?[\s\S]*ORDER BY updated_at DESC, id DESC\s+LIMIT 500$/u,
  );
  assert.deepEqual(supplierQuery.params, ["active", 1]);
});

test("performance delivery dates use Shanghai quarter semantics", async (t) => {
  const database = fixtureDatabase({
    performanceSuppliers: [performanceSupplierRow(9)],
    reviews: [],
    weights: [],
    deliveries: [
      {
        supplierId: 9,
        plannedShipAt: "2026-07-01T00:30:00+08:00",
        shippedAt: "2026-07-01T11:00:00+08:00",
      },
      {
        supplierId: 9,
        plannedShipAt: "2026-07-02T00:30:00+08:00",
        shippedAt: "2026-07-03T00:30:00+08:00",
      },
    ],
  });
  const app = await createApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-performance?quarter=2026-Q3&tier=1",
  });
  assert.equal(response.statusCode, 200, response.body);
  const ranking = response.json().rankings[0];
  assert.equal(ranking.metrics.delivery, 50);
  assert.deepEqual(ranking.automaticMetricEvidence.delivery, {
    evaluatedBatches: 2,
    onTimeBatches: 1,
  });
});

test("performance XLSX uses injected exporter and audit ports", async (t) => {
  const database = fixtureDatabase({
    performanceSuppliers: [performanceSupplierRow(9)],
  });
  const exports = [];
  const audits = [];
  const app = await createApp({
    database,
    exportPerformance: async (input) => {
      exports.push(input);
      return Uint8Array.from([80, 75, 3, 4]);
    },
    audit: async (event, actor) => audits.push({ event, actor }),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/supplier-performance?quarter=2026-Q3&tier=1&format=xlsx",
  });
  assert.equal(response.statusCode, 200, response.body);
  assertPrivateNoStore(response);
  assert.equal(
    response.headers["content-type"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="supplier-performance-2026-Q3.xlsx"',
  );
  assert.deepEqual([...response.rawPayload], [80, 75, 3, 4]);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].quarter, "2026-Q3");
  assert.match(exports[0].watermark, /Reader（reader@example\.com）/u);
  assert.deepEqual(audits, [
    {
      event: {
        action: "export_supplier_performance",
        module: "supplier_performance",
        entityType: "supplier_ranking",
        entityId: "2026-Q3",
        exported: true,
        sensitiveView: true,
        count: 1,
      },
      actor: {
        userId: 1,
        email: "reader@example.com",
        name: "Reader",
        roles: ["admin"],
        factoryId: null,
        supplierId: null,
      },
    },
  ]);
});

test("invalid performance parameters and malformed rows fail through sanitized boundaries", async () => {
  const invalidParameters = await createApp({
    database: fixtureDatabase(),
  });
  try {
    for (const url of [
      "/api/v1/supplier-performance?quarter=2026-Q5",
      "/api/v1/supplier-performance?tier=4",
      "/api/v1/supplier-performance?format=csv",
      "/api/v1/supplier-performance?quarter=2026-Q3&unexpected=1",
    ]) {
      const response = await invalidParameters.inject({ method: "GET", url });
      assert.equal(response.statusCode, 400, url);
      assertPrivateNoStore(response);
      assert.equal(response.json().code, "BAD_REQUEST");
    }
  } finally {
    await invalidParameters.close();
  }

  const malformed = await createApp({
    database: fixtureDatabase({
      performanceSuppliers: [performanceSupplierRow(9)],
      reviews: [
        {
          ...reviewRow(9, 5, "note"),
          tagsJson: "not-json",
        },
      ],
    }),
  });
  try {
    const response = await malformed.inject({
      method: "GET",
      url: "/api/v1/supplier-performance?quarter=2026-Q3&tier=1",
      headers: { "x-request-id": "performance-malformed" },
    });
    assert.equal(response.statusCode, 503);
    assertPrivateNoStore(response);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
      requestId: "performance-malformed",
    });
    assert.doesNotMatch(response.body, /not-json|supplier_performance_reviews/u);
  } finally {
    await malformed.close();
  }
});

test("missing databases and authentication failures retain private sanitized errors", async () => {
  const withoutDatabase = await createApp();
  try {
    const response = await withoutDatabase.inject({
      method: "GET",
      url: "/api/v1/suppliers",
      headers: { "x-request-id": "supplier-no-db" },
    });
    assert.equal(response.statusCode, 503);
    assertPrivateNoStore(response);
    assert.equal(response.json().message, "Internal Server Error");
    assert.doesNotMatch(response.body, /Supplier data unavailable/u);
  } finally {
    await withoutDatabase.close();
  }

  const app = await buildApp({ logger: false });
  await registerSuppliersModule(app, {
    authenticate: async () => {
      const error = new Error("private session detail");
      error.statusCode = 401;
      throw error;
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/supplier-skus",
    });
    assert.equal(response.statusCode, 401);
    assertPrivateNoStore(response);
    assert.doesNotMatch(response.body, /private session detail/u);
  } finally {
    await app.close();
  }
});

test("OpenAPI exposes all four read contracts and no write operations", async (t) => {
  const app = await createApp({ access: context({ localPreview: true }) });
  t.after(() => app.close());
  await app.ready();
  const openapi = app.swagger();

  for (const path of [
    "/api/v1/suppliers",
    "/api/v1/supplier-skus",
    "/api/v1/supplier-prices",
    "/api/v1/supplier-performance",
  ]) {
    assert.ok(openapi.paths[path]?.get, path);
    assert.equal(openapi.paths[path]?.post, undefined, path);
    assert.equal(openapi.paths[path]?.put, undefined, path);
    assert.equal(openapi.paths[path]?.patch, undefined, path);
    assert.equal(openapi.paths[path]?.delete, undefined, path);
  }
  assert.equal(openapi.components.schemas.Suppliers.properties.suppliers.maxItems, 200);
  assert.equal(
    openapi.components.schemas.SupplierPrices.properties.agreements.maxItems,
    2_000,
  );
  assert.equal(
    openapi.components.schemas.SupplierPerformance.properties.rankings.maxItems,
    500,
  );
});
