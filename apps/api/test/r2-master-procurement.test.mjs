import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { R2_COMMAND_BY_MUTATION, R2_COMMANDS } from "@topology/contracts/r2-writes";

import { buildApp } from "../dist/app.js";
import { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "../dist/platform/approvals.js";
import { FileAuthorizationRegistry } from "../dist/platform/registrations.js";
import { executeR2Command } from "../dist/modules/r2-master-procurement/command.js";
import manifest from "../dist/modules/r2-master-procurement/index.js";
import { approvalNotification, domainEvent, requireFile } from "../dist/modules/r2-master-procurement/shared.js";

const TOKEN = "ab".repeat(32);
const KEY = "r2-command-key-00000001";

function securityHeaders() {
  return {
    host: "localhost",
    origin: "http://localhost",
    "x-forwarded-proto": "http",
    cookie: `topology_csrf=${TOKEN}`,
    "x-csrf-token": TOKEN,
    "idempotency-key": KEY,
  };
}

function registrationContext(app, overrides = {}) {
  return {
    app,
    database: { query: async () => [], execute: async () => ({ affectedRows: 1 }), transaction: async (run) => run({}), ping: async () => {}, close: async () => {} },
    unitOfWork: async (run) => run({ query: async () => [], execute: async () => ({ affectedRows: 1 }) }),
    executeCommand: async () => { throw new Error("platform executor must not be used by R2"); },
    requireWriterFence: async () => {},
    authenticate: async () => ({ sessionId: 1, userId: 9, email: "r2@example.com", name: "R2", roles: ["supply_chain"], factoryId: null, supplierId: null, organizationName: "Topology", localPreview: false }),
    authorize: () => false,
    audit: async () => {},
    enqueueOutbox: async () => {},
    approvalPolicy: new ApprovalPolicyRegistry(),
    approvalEffects: new ApprovalEffectRegistry(),
    fileAuthorizations: new FileAuthorizationRegistry(),
    ...overrides,
  };
}

test("R2 manifest registers all 12 write mappings plus isolated approval effects", async (t) => {
  const app = await buildApp({ logger: false });
  const context = registrationContext(app);
  await manifest.register(context);
  await app.ready();
  t.after(() => app.close());

  assert.equal(manifest.id, "r2.master-procurement");
  const paths = app.swagger().paths;
  for (const mapping of Object.keys(R2_COMMAND_BY_MUTATION)) {
    const [method, path] = mapping.split(" ");
    assert.ok(paths[path]?.[method.toLowerCase()], mapping);
  }
  assert.equal(Object.keys(R2_COMMAND_BY_MUTATION).length, 12);
  assert.equal(R2_COMMANDS.length, 12);
  assert.deepEqual(context.approvalEffects.registeredTypes(), [
    "r2.bom_version",
    "r2.purchase_order_factory_exception",
    "r2.purchase_plan_deviation",
    "r2.purchase_plan_factory_exception",
    "r2.purchase_plan_version",
    "r2.sku_verification",
    "r2.supplier_onboarding",
    "r2.supplier_price_change",
    "r2.supplier_sku_change",
  ]);
  assert.ok(paths["/api/v1/supplier-prices/version"]?.get);
});

test("R2 writes reject origin, CSRF, role-only, and mismatched factory bindings before UnitOfWork", async (t) => {
  let unitOfWorkCalls = 0;
  let access = { sessionId: 1, userId: 9, email: "r2@example.com", name: "R2", roles: ["finance"], factoryId: null, supplierId: null, organizationName: "Topology", localPreview: false };
  const app = await buildApp({ logger: false });
  await manifest.register(registrationContext(app, {
    authenticate: async () => access,
    unitOfWork: async () => { unitOfWorkCalls += 1; throw new Error("must not run"); },
  }));
  await app.ready();
  t.after(() => app.close());

  const body = { type: "supplier", fileName: "supplier.xlsx", fingerprint: "fixture", sheets: [{ name: "sheet1", rows: [] }] };
  const noOrigin = await app.inject({ method: "POST", url: "/api/v1/imports/preview", headers: { "idempotency-key": KEY }, payload: body });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(noOrigin.json().code, "ORIGIN_REJECTED");
  const noCsrf = await app.inject({ method: "POST", url: "/api/v1/imports/preview", headers: { host: "localhost", origin: "http://localhost", "x-forwarded-proto": "http", "idempotency-key": KEY }, payload: body });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().code, "CSRF_REJECTED");
  const wrongRole = await app.inject({ method: "POST", url: "/api/v1/imports/preview", headers: securityHeaders(), payload: body });
  assert.equal(wrongRole.statusCode, 403);

  access = { ...access, roles: ["factory"], factoryId: 2 };
  const wrongBinding = await app.inject({
    method: "POST", url: "/api/v1/supplier-skus", headers: securityHeaders(),
    payload: { factoryId: 3, supplierId: 4, sku: "SKU-1", effectiveFrom: "2026-08-12" },
  });
  assert.equal(wrongBinding.statusCode, 403);
  assert.equal(unitOfWorkCalls, 0);
});

test("domain command executor fences, commits once, replays, and rejects digest reuse", async () => {
  let row;
  let runs = 0;
  const transaction = {
    async query(sql) {
      if (sql.includes("FROM command_idempotency")) return [row];
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      if (sql.includes("INSERT IGNORE INTO command_idempotency")) {
        if (row !== undefined) return { affectedRows: 0 };
        row = { requestDigest: params[3], responseJson: null, responseStatus: null, status: "pending" };
        return { affectedRows: 1 };
      }
      if (sql.includes("UPDATE command_idempotency")) {
        row = { ...row, responseStatus: params[0], responseJson: params[1], status: "completed" };
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
  };
  const fences = [];
  const context = {
    unitOfWork: async (run) => run(transaction),
    requireWriterFence: async (_transaction, requirement) => fences.push(requirement),
  };
  const options = {
    actorScope: "user:9",
    command: "supplier-performance.write",
    context,
    payload: { action: "review", score: 5 },
    request: { headers: { "idempotency-key": KEY } },
    async run() { runs += 1; return { ok: true }; },
  };
  const first = await executeR2Command(options);
  const replay = await executeR2Command(options);
  assert.equal(first.body.command.replayed, false);
  assert.equal(replay.body.command.replayed, true);
  assert.equal(runs, 1);
  assert.equal(fences[0].resource, "r2.supplier-performance.write");
  await assert.rejects(
    executeR2Command({ ...options, payload: { action: "review", score: 4 } }),
    (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("R2 separates generic domain events from real approval notifications", async () => {
  const messages = [];
  const context = { enqueueOutbox: async (_transaction, message) => messages.push(message) };
  await domainEvent(context, {}, {
    entityId: 41,
    entityType: "import_batch",
    eventType: "ImportStaged",
    idempotencyKey: KEY,
    recipient: { kind: "role", role: "supply_chain" },
    data: { rowCount: 3, type: "supplier" },
  });
  await approvalNotification(context, {}, {
    approvalId: 77,
    idempotencyKey: KEY,
    targetEntityId: 91,
    targetEntityType: "supplier_sku",
    workflowType: "supplier_sku_change",
  });

  assert.deepEqual(messages[0], {
    topic: "domain.event",
    aggregateType: "import_batch",
    aggregateId: "41",
    deduplicationKey: messages[0].deduplicationKey,
    payload: {
      schemaVersion: 1,
      entityType: "import_batch",
      entityId: "41",
      eventType: "ImportStaged",
      recipient: { kind: "role", role: "supply_chain" },
      data: { rowCount: 3, type: "supplier" },
    },
  });
  assert.equal("approvalId" in messages[0].payload, false);
  assert.deepEqual(messages[1], {
    topic: "notification.dispatch",
    aggregateType: "approval_request",
    aggregateId: "77",
    deduplicationKey: messages[1].deduplicationKey,
    payload: {
      approvalId: 77,
      recipientRole: "supply_chain",
      type: "supplier_sku_change",
      targetEntityType: "supplier_sku",
      targetEntityId: "91",
    },
  });
});

test("import evidence is bound to the authenticated upload owner", async () => {
  const transaction = {
    async query() {
      return [{
        category: "import_source",
        entityId: "9",
        entityType: "import_upload",
        factoryId: null,
        id: 44,
        objectKey: "imports/44.xlsx",
        ownerUserId: 9,
        scanStatus: "clean",
        supplierId: null,
      }];
    },
  };
  const access = { userId: 9, roles: ["supply_chain"], factoryId: null, supplierId: null };
  const file = await requireFile(
    transaction,
    access,
    { id: 44 },
    ["import_source"],
    { entityType: "import_upload", entityIds: [access.userId] },
  );
  assert.equal(file.id, 44);
  await assert.rejects(
    requireFile(
      transaction,
      { ...access, userId: 10 },
      { id: 44 },
      ["import_source"],
      { entityType: "import_upload", entityIds: [10] },
    ),
    (error) => error?.statusCode === 403,
  );
});

test("legacy writers are 410-only and frontend mutations use the v1 adapter/bridge", async () => {
  const root = new URL("../../..", import.meta.url);
  const routes = [
    "app/api/imports/preview/route.ts", "app/api/imports/stage/route.ts", "app/api/imports/commit/route.ts",
    "app/api/master-data/route.ts", "app/api/suppliers/route.ts", "app/api/supplier-skus/route.ts",
    "app/api/supplier-prices/route.ts", "app/api/supplier-performance/route.ts",
    "app/api/purchase-plans/route.ts", "app/api/purchase-orders/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, root), "utf8");
    assert.match(source, /retiredPlatformRoute\("\/api\/v1\//u, route);
    const writePart = source.slice(source.search(/export async function (?:POST|PATCH)/u));
    assert.doesNotMatch(writePart, /getDb\(|\.insert\(|\.update\(/u, route);
  }
  const components = [
    "app/components/MasterDataWorkspace.tsx", "app/components/SupplierWorkspace.tsx",
    "app/components/SupplierPriceWorkspace.tsx", "app/components/SupplierPerformanceWorkspace.tsx",
    "app/components/PurchaseWorkspace.tsx",
  ];
  for (const component of components) {
    const source = await readFile(new URL(component, root), "utf8");
    assert.doesNotMatch(source, /fetch\([`"]\/api\/(?:master-data|suppliers|supplier-skus|supplier-prices|supplier-performance|purchase-plans|purchase-orders)/u, component);
  }
  const bridge = await readFile(new URL("app/api/v1/[...path]/route.ts", root), "utf8");
  for (const path of new Set(Object.keys(R2_COMMAND_BY_MUTATION).map((entry) => entry.slice(entry.indexOf(" ") + 1)))) {
    assert.match(bridge, new RegExp(path.replaceAll("/", "\\/"), "u"), path);
  }
  const fenceSql = await readFile(new URL("drizzle-mysql/0004_scope_a_domain_writes.sql", root), "utf8");
  assert.equal((fenceSql.match(/\('r2\./gu) ?? []).length, 12);
  assert.match(fenceSql, /0004_scope_a_domain_writes|r3_business_keys/u);
  const imports = await readFile(new URL("apps/api/src/modules/r2-master-procurement/imports.ts", root), "utf8");
  const procurement = await readFile(new URL("apps/api/src/modules/r2-master-procurement/procurement.ts", root), "utf8");
  assert.match(imports, /entityType: "import_upload", entityIds: \[access\.userId\]/u);
  assert.equal((procurement.match(/entityType: "import_upload", entityIds: \[access\.userId\]/gu) ?? []).length, 2);
});
