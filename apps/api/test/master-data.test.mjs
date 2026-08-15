import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import {
  registerMasterDataModule,
} from "../dist/modules/master-data/index.js";

const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");

function skuRow(id, status = "active") {
  return {
    id,
    code: `SKU-${id}`,
    name: `SKU ${id}`,
    itemType: id % 2 === 0 ? "component" : "finished",
    stockUnit: id % 2 === 0 ? null : "pcs",
    status,
    verificationStatus: status === "active" ? "approved" : "pending",
  };
}

function bomRow(
  id,
  {
    active = 1,
    approvalStatus = "approved",
    effectiveFrom = "2026-01-01",
    effectiveTo = null,
  } = {},
) {
  return {
    id,
    finishedSku: "SKU-1",
    version: `V${id}`,
    effectiveFrom,
    effectiveTo,
    approvalStatus,
    overlapAllowed: id % 2,
    overlapReason: id % 2 ? "planned" : "",
    active,
  };
}

function conversionRow(id, skuId) {
  return {
    id,
    skuId,
    purchaseUnit: "box",
    stockUnit: "pcs",
    purchaseUnitQuantity: 1,
    stockUnitQuantity: 10,
    effectiveFrom: "2026-01-01",
    status: "active",
  };
}

function componentRow(id, bomId) {
  return {
    id,
    bomId,
    componentSku: `COMPONENT-${id}`,
    itemType: "component",
    quantityPerFinished: 1,
    isCore: id % 2,
    issueToleranceBps: 0,
    consumptionToleranceBps: 0,
    lossToleranceBps: 0,
  };
}

function fakeDatabase({
  boms = [],
  components = [],
  conversions = [],
  skus = [],
} = {}) {
  const queries = [];

  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("FROM skus")) return skus;
      if (sql.includes("FROM product_boms")) return boms;
      if (sql.includes("FROM sku_unit_conversions")) {
        return conversions.filter((row) => params.includes(row.skuId));
      }
      if (sql.includes("FROM bom_components")) {
        return components.filter((row) => params.includes(row.bomId));
      }
      throw new Error("Unexpected SQL");
    },
    async execute() {
      throw new Error("Master Data GET must not execute writes");
    },
  };
}

async function createMasterDataApp({ context, database } = {}) {
  const app = await buildApp({ logger: false });
  await registerMasterDataModule(app, {
    authenticate: async () =>
      context ?? {
        factoryId: null,
        localPreview: false,
        roles: ["admin"],
      },
    ...(database === undefined ? {} : { database }),
    now: fixedNow,
  });
  return app;
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.vary, "Cookie");
}

test("full-access roles receive bounded data with stable order and lifecycle semantics", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
    const database = fakeDatabase({
      skus: [skuRow(2, "draft"), skuRow(1)],
      conversions: [conversionRow(11, 2), conversionRow(10, 1)],
      boms: [
        bomRow(20, { active: 0 }),
        bomRow(21, { approvalStatus: "pending" }),
        bomRow(22, { effectiveFrom: "2026-09-01" }),
        bomRow(23, { effectiveTo: "2026-08-10" }),
        bomRow(24, { effectiveFrom: "2026-08-11" }),
      ],
      components: [componentRow(30, 20), componentRow(31, 24)],
    });
    const app = await createMasterDataApp({
      database,
      context: { factoryId: null, localPreview: false, roles: [role] },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/master-data",
      });

      assert.equal(response.statusCode, 200, role);
      assertPrivateNoStore(response);
      const body = response.json();
      assert.deepEqual(body.skus.map((row) => row.id), [2, 1]);
      assert.deepEqual(body.boms.map((row) => row.lifecycleStatus), [
        "inactive",
        "pending",
        "future",
        "expired",
        "effective",
      ]);
      assert.deepEqual(body.conversions.map((row) => row.skuId), [2, 1]);
      assert.deepEqual(body.components.map((row) => row.bomId), [20, 24]);
      assert.equal(body.skus[0].stockUnit, null);
      assert.equal(body.boms[0].effectiveTo, null);

      assert.equal(database.queries.length, 4);
      assert.match(
        database.queries[0].sql,
        /ORDER BY updated_at DESC, id DESC\s+LIMIT 500$/u,
      );
      assert.match(
        database.queries[1].sql,
        /ORDER BY updated_at DESC, id DESC\s+LIMIT 500$/u,
      );
      assert.match(
        database.queries[2].sql,
        /WHERE conversions\.sku_id IN \(\?, \?\)\s+ORDER BY conversions\.sku_id ASC, conversions\.id ASC\s+LIMIT 1001$/u,
      );
      assert.deepEqual(database.queries[2].params, [2, 1]);
      assert.match(
        database.queries[3].sql,
        /WHERE components\.bom_id IN \(\?, \?, \?, \?, \?\)\s+ORDER BY components\.bom_id ASC, components\.id ASC\s+LIMIT 2001$/u,
      );
      assert.deepEqual(database.queries[3].params, [20, 21, 22, 23, 24]);

      const openapi = app.swagger();
      assert.ok(openapi.paths["/api/v1/master-data"]?.get);
      assert.equal(
        openapi.components.schemas.MasterData.properties.conversions.maxItems,
        1_000,
      );
      assert.equal(
        openapi.components.schemas.MasterData.properties.components.maxItems,
        2_000,
      );
    } finally {
      await app.close();
    }
  }
});

test("a factory with a valid factory id sees only active global company standards", async (t) => {
  const database = fakeDatabase({
    skus: [skuRow(1)],
    conversions: [conversionRow(10, 1), conversionRow(11, 2)],
    boms: [bomRow(24)],
    components: [componentRow(31, 24), componentRow(32, 25)],
  });
  const app = await createMasterDataApp({
    database,
    context: { factoryId: 9, localPreview: false, roles: ["factory"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/master-data",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json().conversions.map((row) => row.skuId), [1]);
  assert.deepEqual(response.json().components.map((row) => row.bomId), [24]);
  assert.match(
    database.queries[0].sql,
    /WHERE status = \?\s+ORDER BY updated_at DESC, id DESC\s+LIMIT 500$/u,
  );
  assert.deepEqual(database.queries[0].params, ["active"]);
  assert.match(
    database.queries[1].sql,
    /WHERE approval_status = \? AND active = \?\s+ORDER BY updated_at DESC, id DESC\s+LIMIT 500$/u,
  );
  assert.deepEqual(database.queries[1].params, ["approved", 1]);
});

test("finance, scoped non-factory roles, and invalid factories are forbidden before database access", async () => {
  const deniedContexts = [
    { factoryId: null, localPreview: false, roles: ["finance"] },
    { factoryId: 7, localPreview: false, roles: ["supplier_qc"] },
    { factoryId: 7, localPreview: false, roles: ["receiver"] },
    { factoryId: null, localPreview: false, roles: ["unknown"] },
    { factoryId: null, localPreview: false, roles: ["factory"] },
    { factoryId: 0, localPreview: false, roles: ["factory"] },
  ];

  for (const context of deniedContexts) {
    const database = fakeDatabase();
    const app = await createMasterDataApp({ context, database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/master-data",
        headers: { "x-request-id": `denied-${context.roles[0]}` },
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

test("authentication failures retain private no-store headers", async (t) => {
  const app = await buildApp({ logger: false });
  await registerMasterDataModule(app, {
    authenticate: async () => {
      const error = new Error("private authentication detail");
      error.statusCode = 401;
      throw error;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/master-data",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "UNAUTHORIZED");
  assert.doesNotMatch(response.body, /private authentication detail/u);
  assertPrivateNoStore(response);
});

test("local preview short-circuits authentication scope and database", async (t) => {
  const app = await createMasterDataApp({
    context: { factoryId: null, localPreview: true, roles: ["finance"] },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/master-data",
  });

  assert.equal(response.statusCode, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(response.json(), {
    skus: [],
    conversions: [],
    boms: [],
    components: [],
    preview: true,
  });
});

test("empty parent sets skip both child queries", async (t) => {
  const database = fakeDatabase();
  const app = await createMasterDataApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/master-data",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    skus: [],
    conversions: [],
    boms: [],
    components: [],
  });
  assert.equal(database.queries.length, 2);
});

test("child lookup is closed over the selected 500 of 1000 BOMs", async (t) => {
  const allBoms = Array.from({ length: 1_000 }, (_, index) =>
    bomRow(index + 1),
  );
  const selectedBoms = allBoms.slice(500);
  const database = fakeDatabase({
    boms: selectedBoms,
    components: allBoms.map((row) => componentRow(row.id, row.id)),
  });
  const app = await createMasterDataApp({ database });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/master-data",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.boms.length, 500);
  assert.equal(body.components.length, 500);
  assert.equal(body.components[0].bomId, 501);
  assert.equal(body.components.at(-1).bomId, 1_000);
  const componentQuery = database.queries.find(({ sql }) =>
    sql.includes("FROM bom_components"),
  );
  assert.deepEqual(
    componentQuery.params,
    selectedBoms.map((row) => row.id),
  );
  assert.ok(componentQuery.params.every((id) => id > 500));
});

test("child hard-limit probes fail closed instead of returning truncated 200s", async () => {
  for (const fixture of [
    {
      skus: [skuRow(1)],
      conversions: Array.from({ length: 1_001 }, (_, index) =>
        conversionRow(index + 1, 1),
      ),
    },
    {
      boms: [bomRow(1)],
      components: Array.from({ length: 2_001 }, (_, index) =>
        componentRow(index + 1, 1),
      ),
    },
  ]) {
    const app = await createMasterDataApp({ database: fakeDatabase(fixture) });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/master-data",
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().message, "Internal Server Error");
      assertPrivateNoStore(response);
    } finally {
      await app.close();
    }
  }
});

test("missing database and malformed child closure fail through the sanitized boundary", async () => {
  const withoutDatabase = await createMasterDataApp();
  try {
    const response = await withoutDatabase.inject({
      method: "GET",
      url: "/api/v1/master-data",
      headers: { "x-request-id": "master-data-no-db" },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
      requestId: "master-data-no-db",
    });
    assertPrivateNoStore(response);
  } finally {
    await withoutDatabase.close();
  }

  const database = fakeDatabase({
    skus: [skuRow(1)],
    conversions: [conversionRow(1, 999)],
  });
  database.query = async (sql, params = []) => {
    database.queries.push({ sql, params });
    if (sql.includes("FROM skus")) return [skuRow(1)];
    if (sql.includes("FROM product_boms")) return [];
    if (sql.includes("FROM sku_unit_conversions")) {
      return [conversionRow(1, 999)];
    }
    return [];
  };
  const malformed = await createMasterDataApp({ database });
  try {
    const response = await malformed.inject({
      method: "GET",
      url: "/api/v1/master-data",
    });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /999|Master data access/u);
  } finally {
    await malformed.close();
  }
});

test("frontend uses the v1 master-data mutation adapter and reports read failures", async () => {
  const source = await readFile(
    new URL("../../../apps/web/app/components/MasterDataWorkspace.tsx", import.meta.url),
    "utf8",
  );
  const requestSource = source.slice(
    source.indexOf("async function requestMasterData"),
    source.indexOf("export default function MasterDataWorkspace"),
  );
  const loadStart = source.indexOf("const load");
  const loadSource = source.slice(
    loadStart,
    source.indexOf("useEffect", loadStart),
  );

  assert.match(requestSource, /fetch\("\/api\/v1\/master-data", \{ signal \}\)/u);
  assert.match(requestSource, /if \(!response\.ok\) throw/u);
  assert.match(loadSource, /requestMasterData\(\)/u);
  assert.match(loadSource, /catch/u);
  assert.match(loadSource, /toastRef\.current\("主数据加载失败，请稍后重试"\)/u);
  assert.match(source, /new AbortController\(\)/u);
  assert.match(source, /requestMasterData\(controller\.signal\)/u);
  assert.match(source, /writeMasterData/u);
  assert.doesNotMatch(source, /fetch\("\/api\/master-data", \{ method: "POST"/u);
});
