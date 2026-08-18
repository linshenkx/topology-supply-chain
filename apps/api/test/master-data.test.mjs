import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import {
  registerMasterDataModule,
} from "../dist/modules/master-data/index.js";
import { writeMasterData } from "../dist/modules/master-data/writes.js";

const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");
const TOKEN = "ef".repeat(32);

function skuRow(
  id,
  status = "active",
  verificationStatus = status === "active" ? "approved" : "pending",
) {
  return {
    id,
    code: `SKU-${id}`,
    name: `SKU ${id}`,
    itemType: id % 2 === 0 ? "component" : "finished",
    stockUnit: id % 2 === 0 ? null : "pcs",
    overproductionToleranceBps: id * 10,
    purchaseOverToleranceBps: id * 20,
    purchaseUnderToleranceBps: id * 30,
    status,
    verificationStatus,
  };
}

function approvalRow(skuId, status = "approved", reviewComment = null) {
  return {
    skuId,
    requestNo: `AP-${skuId}`,
    status,
    requestedAt: "2026-08-10 08:00:00.000",
    reviewedAt: status === "pending" ? null : "2026-08-11 08:00:00.000",
    reviewComment,
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
  approvals = [],
  skus = [],
} = {}) {
  const queries = [];

  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("FROM skus")) return skus;
      if (sql.includes("FROM product_boms")) return boms;
      if (sql.includes("FROM approval_requests")) {
        return approvals.filter((row) => params.includes(row.skuId));
      }
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

function writeRequest(key) {
  return {
    headers: {
      "idempotency-key": key,
      "x-csrf-token": TOKEN,
      cookie: `topology_csrf=${TOKEN}`,
    },
  };
}

function writeAccess(roles = ["supply_chain"]) {
  return {
    sessionId: 1,
    userId: 9,
    email: "supply@example.com",
    name: "Supply",
    roles,
    factoryId: null,
    supplierId: null,
    organizationName: "Topology",
    localPreview: false,
  };
}

function writeTransaction({
  conversions = [],
  sku = {
    id: 42,
    code: "SKU-RESUBMIT",
    itemType: "finished",
    stockUnit: "pcs",
    status: "draft",
    verificationStatus: "rejected",
  },
} = {}) {
  const state = {
    approvals: [],
    commandRows: new Map(),
    conversions: conversions.map((row) => ({ ...row })),
    sku: { ...sku },
  };
  const businessExecutes = [];
  const executes = [];
  const queries = [];

  const transaction = {
    businessExecutes,
    executes,
    queries,
    state,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM command_idempotency")) {
        return [state.commandRows.get(params.slice(0, 3).join("|"))].filter(Boolean);
      }
      if (sql.includes("FROM skus WHERE id = ? LIMIT 1 FOR UPDATE")) {
        return state.sku.id === params[0] ? [{ ...state.sku }] : [];
      }
      if (sql.includes("FROM sku_unit_conversions")) {
        return state.conversions.filter((row) => row.skuId === params[0]);
      }
      throw new Error(`Unexpected write query: ${sql}`);
    },
    async execute(sql, params = []) {
      executes.push({ sql, params });
      if (sql.includes("command_idempotency")) {
        const key = params.slice(0, 3).join("|");
        if (sql.includes("INSERT IGNORE")) {
          if (state.commandRows.has(key)) return { affectedRows: 0 };
          state.commandRows.set(key, {
            requestDigest: params[3],
            responseJson: null,
            responseStatus: null,
            status: "pending",
          });
          return { affectedRows: 1 };
        }
        if (sql.includes("UPDATE command_idempotency")) {
          const storedKey = params.slice(2, 5).join("|");
          const row = state.commandRows.get(storedKey);
          if (row === undefined || row.requestDigest !== params[5] || row.status !== "pending") {
            return { affectedRows: 0 };
          }
          state.commandRows.set(storedKey, {
            ...row,
            responseJson: params[1],
            responseStatus: params[0],
            status: "completed",
          });
          return { affectedRows: 1 };
        }
      }

      businessExecutes.push({ sql, params });
      if (sql.startsWith("UPDATE skus")) {
        if (state.sku.verificationStatus !== "rejected" || state.sku.status !== "draft") return { affectedRows: 0 };
        state.sku = {
          ...state.sku,
          name: params[0],
          itemType: params[1],
          stockUnit: params[2],
          overproductionToleranceBps: params[3],
          purchaseOverToleranceBps: params[4],
          purchaseUnderToleranceBps: params[5],
          verificationStatus: "pending",
          status: "draft",
        };
        return { affectedRows: 1 };
      }
      if (sql.startsWith("UPDATE sku_unit_conversions")) {
        if (sql.includes("SET status = 'inactive'")) {
          const row = state.conversions.find((conversion) => conversion.id === params[0] && conversion.skuId === params[1] && conversion.status === "active");
          if (row === undefined) return { affectedRows: 0 };
          row.status = "inactive";
          return { affectedRows: 1 };
        }
        const row = state.conversions.find((conversion) => conversion.id === params[5] && conversion.skuId === params[6]);
        if (row === undefined) return { affectedRows: 0 };
        Object.assign(row, {
          purchaseUnit: params[0],
          stockUnit: params[1],
          purchaseUnitQuantity: params[2],
          stockUnitQuantity: params[3],
          effectiveFrom: params[4],
          status: "active",
        });
        return { affectedRows: 1 };
      }
      if (sql.startsWith("INSERT INTO sku_unit_conversions")) {
        state.conversions.push({
          id: 501 + state.conversions.length,
          skuId: params[0],
          purchaseUnit: params[1],
          stockUnit: params[2],
          purchaseUnitQuantity: params[3],
          stockUnitQuantity: params[4],
          effectiveFrom: params[5],
          status: "active",
        });
        return { affectedRows: 1, insertId: state.conversions.at(-1).id };
      }
      if (sql.startsWith("INSERT INTO approval_requests")) {
        const id = 800 + state.approvals.length;
        state.approvals.push({
          id,
          requestNo: params[0],
          workflowType: params[1],
          entityType: params[2],
          entityId: params[3],
          summary: params[4],
          payloadJson: params[5],
          highRisk: params[6],
          requestedBy: params[7],
        });
        return { affectedRows: 1, insertId: id };
      }
      if (sql.startsWith("INSERT INTO resource_versions") || sql.startsWith("INSERT INTO audit_logs")) {
        return { affectedRows: 1 };
      }
      throw new Error(`Unexpected write execute: ${sql}`);
    },
  };
  return transaction;
}

function writeContext(transaction, outbox = []) {
  return {
    unitOfWork: async (run) => run(transaction),
    requireWriterFence: async () => {},
    enqueueOutbox: async (_transaction, message) => outbox.push(message),
  };
}

test("full-access roles receive bounded data with stable order and lifecycle semantics", async () => {
  for (const role of ["admin", "supply_chain", "company_qc"]) {
      const database = fakeDatabase({
        skus: [skuRow(2, "draft", "rejected"), skuRow(1)],
        conversions: [conversionRow(11, 2), conversionRow(10, 1)],
        approvals: [approvalRow(2, "rejected", "规格不完整"), approvalRow(1)],
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
      assert.equal(body.skus[0].overproductionToleranceBps, 20);
      assert.equal(body.skus[0].purchaseOverToleranceBps, 40);
      assert.equal(body.skus[0].purchaseUnderToleranceBps, 60);
      assert.equal(body.skus[0].latestApproval.reviewComment, "规格不完整");
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

      assert.equal(database.queries.length, 5);
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
        /FROM approval_requests/u,
      );
      assert.deepEqual(database.queries[2].params, ["sku_verification", "sku", 2, 1]);
      assert.match(
        database.queries[3].sql,
        /WHERE conversions\.sku_id IN \(\?, \?\)\s+ORDER BY conversions\.sku_id ASC, conversions\.id ASC\s+LIMIT 1001$/u,
      );
      assert.deepEqual(database.queries[3].params, [2, 1]);
      assert.match(
        database.queries[4].sql,
        /WHERE components\.bom_id IN \(\?, \?, \?, \?, \?\)\s+ORDER BY components\.bom_id ASC, components\.id ASC\s+LIMIT 2001$/u,
      );
      assert.deepEqual(database.queries[4].params, [20, 21, 22, 23, 24]);

      const openapi = app.swagger();
      assert.ok(openapi.paths["/api/v1/master-data"]?.get);
      assert.equal(
        openapi.components.schemas.MasterData.properties.conversions.maxItems,
        1_000,
      );
      assert.equal(
        openapi.components.schemas.MasterData.properties.skus.items.properties.latestApproval.anyOf[1].properties.reviewComment.anyOf[0].type,
        "null",
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
  assert.deepEqual(response.json().skus[0].latestApproval, null);
  assert.deepEqual(response.json().components.map((row) => row.bomId), [24]);
  assert.equal(database.queries.some(({ sql }) => sql.includes("FROM approval_requests")), false);
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
  assert.equal(database.queries.length, 4);
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

test("master-data.write resubmits rejected SKUs without changing id or code", async () => {
  const outbox = [];
  const transaction = writeTransaction({
    conversions: [{
      id: 77,
      skuId: 42,
      purchaseUnit: "box",
      stockUnit: "pcs",
      purchaseUnitQuantity: 1,
      stockUnitQuantity: 10,
      effectiveFrom: "2026-01-01",
      status: "active",
    }],
  });
  const payload = {
    action: "resubmit_sku",
    id: 42,
    name: "SKU Resubmitted",
    itemType: "component",
    stockUnit: "box",
    purchaseUnit: "carton",
    purchaseUnitQuantity: 3,
    stockUnitQuantity: 12,
    effectiveFrom: "2026-09-01",
    overproductionTolerance: 4,
    purchaseOverTolerance: 5,
    purchaseUnderTolerance: 6,
  };

  const response = await writeMasterData(
    writeContext(transaction, outbox),
    writeRequest("master-data-resubmit-key-0001"),
    writeAccess(),
    payload,
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.command.command, "master-data.write");
  assert.equal(response.body.command.replayed, false);
  assert.deepEqual(response.body.result.sku, {
    id: 42,
    code: "SKU-RESUBMIT",
    name: "SKU Resubmitted",
    itemType: "component",
    stockUnit: "box",
    verificationStatus: "pending",
    status: "draft",
  });
  assert.equal(transaction.state.sku.code, "SKU-RESUBMIT");
  assert.equal(transaction.state.sku.verificationStatus, "pending");
  assert.equal(transaction.state.conversions[0].purchaseUnit, "carton");
  assert.equal(transaction.state.conversions[0].effectiveFrom, "2026-09-01");
  assert.equal(transaction.state.approvals.length, 1);
  assert.equal(transaction.state.approvals[0].workflowType, "sku_verification");
  assert.match(transaction.state.approvals[0].summary, /Resubmitted SKU: SKU-RESUBMIT/u);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].topic, "notification.dispatch");
  assert.equal(outbox[0].payload.type, "sku_verification");
  assert.equal(
    transaction.businessExecutes.filter(({ sql }) => sql.startsWith("UPDATE skus")).length,
    1,
  );
  assert.equal(
    transaction.businessExecutes.filter(({ sql }) => sql.startsWith("INSERT INTO audit_logs")).length,
    1,
  );

  const replay = await writeMasterData(
    writeContext(transaction, outbox),
    writeRequest("master-data-resubmit-key-0001"),
    writeAccess(),
    payload,
  );
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.body.command.replayed, true);
  assert.equal(transaction.state.approvals.length, 1);
  assert.equal(outbox.length, 1);

  await assert.rejects(
    writeMasterData(
      writeContext(transaction, outbox),
      writeRequest("master-data-resubmit-key-0001"),
      writeAccess(),
      { ...payload, name: "Different payload" },
    ),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("master-data.write clears active conversion when purchase unit is removed and records conversion audit", async () => {
  const transaction = writeTransaction({
    conversions: [{
      id: 77,
      skuId: 42,
      purchaseUnit: "box",
      stockUnit: "pcs",
      purchaseUnitQuantity: 1,
      stockUnitQuantity: 10,
      effectiveFrom: "2026-01-01",
      status: "active",
    }],
  });
  const payload = {
    action: "resubmit_sku",
    id: 42,
    name: "SKU Resubmitted",
    itemType: "component",
    stockUnit: "box",
    purchaseUnit: "",
    purchaseUnitQuantity: 3,
    stockUnitQuantity: 12,
    effectiveFrom: "",
    overproductionTolerance: 4,
    purchaseOverTolerance: 5,
    purchaseUnderTolerance: 6,
  };

  const response = await writeMasterData(
    writeContext(transaction),
    writeRequest("master-data-resubmit-clear-key-0001"),
    writeAccess(),
    payload,
  );
  assert.equal(response.statusCode, 201);
  assert.equal(transaction.state.conversions[0].status, "inactive");
  assert.equal(transaction.state.conversions[0].purchaseUnit, "box");
  assert.equal(transaction.state.approvals.length, 1);
  const auditInsert = transaction.businessExecutes.find(({ sql }) => sql.startsWith("INSERT INTO audit_logs"));
  const before = JSON.parse(auditInsert.params[6]);
  const after = JSON.parse(auditInsert.params[7]);
  assert.deepEqual(before.conversion, {
    id: 77,
    skuId: 42,
    purchaseUnit: "box",
    stockUnit: "pcs",
    purchaseUnitQuantity: 1,
    stockUnitQuantity: 10,
    effectiveFrom: "2026-01-01",
    status: "active",
  });
  assert.equal(after.conversion.status, "inactive");
  assert.equal(after.conversion.purchaseUnit, "box");
  assert.equal(after.sku.verificationStatus, "pending");
  assert.equal(after.approvalId, transaction.state.approvals[0].id);
});

test("master-data.write fail-closes when more than one active conversion exists", async () => {
  const transaction = writeTransaction({
    conversions: [
      {
        id: 77,
        skuId: 42,
        purchaseUnit: "box",
        stockUnit: "pcs",
        purchaseUnitQuantity: 1,
        stockUnitQuantity: 10,
        effectiveFrom: "2026-01-01",
        status: "active",
      },
      {
        id: 78,
        skuId: 42,
        purchaseUnit: "carton",
        stockUnit: "pcs",
        purchaseUnitQuantity: 2,
        stockUnitQuantity: 20,
        effectiveFrom: "2026-02-01",
        status: "active",
      },
    ],
  });

  await assert.rejects(
    writeMasterData(
      writeContext(transaction),
      writeRequest("master-data-resubmit-multi-active-key-0001"),
      writeAccess(),
      {
        action: "resubmit_sku",
        id: 42,
        name: "SKU Resubmitted",
        itemType: "component",
        stockUnit: "box",
        purchaseUnit: "",
        overproductionTolerance: 4,
        purchaseOverTolerance: 5,
        purchaseUnderTolerance: 6,
      },
    ),
    (error) => error.statusCode === 409,
  );
  assert.equal(transaction.state.conversions[0].status, "active");
  assert.equal(transaction.state.conversions[1].status, "active");
  assert.equal(transaction.state.approvals.length, 0);
  assert.equal(transaction.businessExecutes.filter(({ sql }) => sql.startsWith("UPDATE sku_unit_conversions")).length, 0);
});

test("master-data.write resubmit fail-closes forbidden and non-rejected states", async () => {
  const payload = {
    action: "resubmit_sku",
    id: 42,
    name: "SKU Resubmitted",
    itemType: "component",
    stockUnit: "box",
    overproductionTolerance: 4,
    purchaseOverTolerance: 5,
    purchaseUnderTolerance: 6,
  };

  const forbiddenTransaction = writeTransaction();
  await assert.rejects(
    writeMasterData(
      writeContext(forbiddenTransaction),
      writeRequest("master-data-forbidden-key-0001"),
      writeAccess(["finance"]),
      payload,
    ),
    (error) => error.statusCode === 403,
  );
  assert.equal(forbiddenTransaction.queries.length, 0);
  assert.equal(forbiddenTransaction.executes.length, 0);

  for (const [label, sku] of [
    ["pending", { id: 42, code: "SKU-PENDING", itemType: "finished", stockUnit: "pcs", status: "draft", verificationStatus: "pending" }],
    ["approved", { id: 42, code: "SKU-APPROVED", itemType: "finished", stockUnit: "pcs", status: "draft", verificationStatus: "approved" }],
    ["inactive", { id: 42, code: "SKU-INACTIVE", itemType: "finished", stockUnit: "pcs", status: "inactive", verificationStatus: "rejected" }],
  ]) {
    const transaction = writeTransaction({ sku });
    await assert.rejects(
      writeMasterData(
        writeContext(transaction),
        writeRequest(`master-data-${label}-key-0001`),
        writeAccess(),
        payload,
      ),
      (error) => error.statusCode === 409,
    );
    assert.equal(transaction.businessExecutes.length, 0, label);
    assert.equal(transaction.state.approvals.length, 0, label);
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
  assert.match(source, /latestApproval/u);
  assert.match(source, /复制为新版本/u);
  assert.match(source, /修改并重新提交/u);
  assert.match(source, /conversions/u);
  assert.match(source, /writeMasterData/u);
  const copyBomStart = source.indexOf("const copyBom");
  const copyBomSource = source.slice(
    copyBomStart,
    source.indexOf("const toggleCompare", copyBomStart),
  );
  assert.match(copyBomSource, /version: "",\s+effectiveFrom: "",/u);
  assert.match(source, /请先填写新版本号和生效日期/u);
  assert.match(source, /className="master-mask detail-mask"/u);
  assert.doesNotMatch(source, /fetch\("\/api\/master-data", \{ method: "POST"/u);
});
