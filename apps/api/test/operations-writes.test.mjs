import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OPERATIONS_COMMANDS,
  OPERATIONS_COMMAND_RESOURCES,
} from "../../../packages/contracts/dist/operations-writes.js";
import { buildRuntimeApp } from "../dist/runtime.js";
import operationsManifest from "../dist/composition/operations-writes-manifest.js";

const root = new URL("../../../", import.meta.url);

test("Operations exposes exactly the 14 delegated route-method commands", () => {
  assert.equal(Object.keys(OPERATIONS_COMMANDS).length, 14);
  assert.deepEqual(new Set(Object.values(OPERATIONS_COMMANDS)), new Set([
    "approvals.decide",
    "inventory.reserve",
    "inventory.transfer.request",
    "inventory.transfer.transition",
    "manufacturing.order.create",
    "manufacturing.order.transition",
    "purchase.receive",
    "quality.inspection.submit",
    "inventory.stocktake.open",
    "inventory.stocktake.transition",
    "logistics.shipment.command",
    "returns.command",
    "finance.command",
    "warehouses.command",
  ]));
  assert.deepEqual(Object.keys(OPERATIONS_COMMAND_RESOURCES).sort(), Object.values(OPERATIONS_COMMANDS).sort());
  assert.equal(operationsManifest.id, "r3.fulfillment-writes");
});

test("Operations manifest registers all route-method pairs without modifying runtime", async (t) => {
  const app = await buildRuntimeApp({
    logger: false,
    registrationManifests: [operationsManifest],
    environment: { NODE_ENV: "test" },
  });
  t.after(() => app.close());
  for (const [path, methods] of [
    ["approvals", ["POST"]],
    ["inventory", ["POST"]],
    ["inventory/transfers", ["POST", "PATCH"]],
    ["production-orders", ["POST", "PATCH"]],
    ["purchase-receipts", ["POST"]],
    ["quality-inspections", ["POST"]],
    ["stocktakes", ["POST", "PATCH"]],
    ["shipments", ["POST"]],
    ["returns", ["POST"]],
    ["finance", ["POST"]],
    ["warehouses", ["POST"]],
  ]) {
    for (const method of methods) {
      assert.equal(app.hasRoute({ method, url: `/api/v1/${path}` }), true, `${method} /api/v1/${path}`);
    }
  }
});

test("all 14 delegated command bodies cross the Fastify contract boundary", async (t) => {
  const app = await buildRuntimeApp({
    logger: false,
    registrationManifests: [operationsManifest],
    environment: { NODE_ENV: "test" },
  });
  t.after(() => app.close());
  const samples = [
    ["POST", "/api/v1/approvals", { id: 1, decision: "approved" }],
    ["POST", "/api/v1/inventory", { batchId: 1, entityType: "historical", requestedQuantity: 1 }],
    ["POST", "/api/v1/inventory/transfers", { fromWarehouseId: 1, toWarehouseId: 2, sku: "SKU", quantity: 1, reason: "test" }],
    ["PATCH", "/api/v1/inventory/transfers", { id: 1, action: "ship" }],
    ["POST", "/api/v1/production-orders", { orderItemId: 1, factoryId: 1, bomId: 1, plannedQuantity: 1, plannedStartDate: "2099-01-01", plannedFinishDate: "2099-01-02" }],
    ["PATCH", "/api/v1/production-orders", { id: 1, action: "start" }],
    ["POST", "/api/v1/purchase-receipts", { purchaseOrderId: 1, orderItemId: 1, warehouseId: 1 }],
    ["POST", "/api/v1/quality-inspections", { executionOrderId: 1, stage: "finished_goods", inspectionMethod: "sampling", batchQuantity: 1, inspectedQuantity: 1, passedQuantity: 1, failedQuantity: 0, inspectorType: "company_qc" }],
    ["POST", "/api/v1/stocktakes", { warehouseId: 1, scope: "full_warehouse", dueDate: "2099-01-01" }],
    ["PATCH", "/api/v1/stocktakes", { id: 1, action: "finish_round" }],
    ["POST", "/api/v1/shipments", { action: "create", executionOrderId: 1, batchNo: "B-1", quantity: 1, plannedShipAt: "2099-01-01", destination: "test" }],
    ["POST", "/api/v1/returns", { action: "receive", returnNo: "R-1", sourceDeliveryBatchId: 1, warehouseId: 1, quantity: 1 }],
    ["POST", "/api/v1/finance", { action: "invalidate_invoice", invoiceId: 1, exceptionType: "voided", reason: "test", replacementDeadline: "2099-01-01" }],
    ["POST", "/api/v1/warehouses", { action: "create", code: "WH-1", name: "Warehouse", type: "company" }],
  ];
  for (const [method, url, payload] of samples) {
    const response = await app.inject({
      method,
      url,
      headers: { "idempotency-key": randomUUID() },
      payload,
    });
    assert.notEqual(response.statusCode, 400, `${method} ${url}: ${response.body}`);
  }
});

test("each operations delegated route rejects an invalid body at its declared schema boundary", async (t) => {
  const app = await buildRuntimeApp({
    logger: false,
    registrationManifests: [operationsManifest],
    environment: { NODE_ENV: "test" },
  });
  t.after(() => app.close());
  const routes = [
    ["POST", "/api/v1/approvals"], ["POST", "/api/v1/inventory"],
    ["POST", "/api/v1/inventory/transfers"], ["PATCH", "/api/v1/inventory/transfers"],
    ["POST", "/api/v1/production-orders"], ["PATCH", "/api/v1/production-orders"],
    ["POST", "/api/v1/purchase-receipts"],
    ["POST", "/api/v1/quality-inspections"], ["POST", "/api/v1/stocktakes"],
    ["PATCH", "/api/v1/stocktakes"], ["POST", "/api/v1/shipments"],
    ["POST", "/api/v1/returns"], ["POST", "/api/v1/finance"], ["POST", "/api/v1/warehouses"],
  ];
  for (const [method, url] of routes) {
    const response = await app.inject({ method, url, headers: { "idempotency-key": randomUUID() }, payload: {} });
    assert.equal(response.statusCode, 400, `${method} ${url}: ${response.body}`);
  }
});

test("legacy writers are fail-fast 410 gates and the frontend has no delegated legacy mutation URL", async () => {
  const legacy = [
    ["apps/web/app/api/approvals/route.ts", ["POST"]],
    ["apps/web/app/api/inventory/route.ts", ["POST"]],
    ["apps/web/app/api/inventory/transfers/route.ts", ["POST", "PATCH"]],
    ["apps/web/app/api/production-orders/route.ts", ["POST", "PATCH"]],
    ["apps/web/app/api/quality-inspections/route.ts", ["POST"]],
    ["apps/web/app/api/stocktakes/route.ts", ["POST", "PATCH"]],
    ["apps/web/app/api/shipments/route.ts", ["POST"]],
    ["apps/web/app/api/returns/route.ts", ["POST"]],
    ["apps/web/app/api/finance/route.ts", ["POST"]],
    ["apps/web/app/api/warehouses/route.ts", ["POST"]],
  ];
  for (const [path, methods] of legacy) {
    const source = await readFile(new URL(path, root), "utf8");
    for (const method of methods) {
      assert.match(source, new RegExp(
        `export async function ${method}(?:\\(\\) \\{ return retiredPlatformRoute\\(|\\(request: Request\\) \\{\\s+if \\(request\\.method\\.length >= 0\\) return retiredPlatformRoute\\()`,
        "u",
      ));
    }
    if (/export async function POST\(\) \{ return retiredPlatformRoute\(/u.test(source)) {
      assert.doesNotMatch(source, /getDb\(|requireAccess\(|requireRole\(|\.insert\(|\.update\(/u);
    }
  }
  const frontend = await Promise.all([
    "apps/web/app/page.tsx",
    "apps/web/app/components/InventoryWorkspace.tsx",
    "apps/web/app/components/ProductionWorkspace.tsx",
    "apps/web/app/components/StocktakeWorkspace.tsx",
    "apps/web/app/components/ShippingWorkspace.tsx",
    "apps/web/app/components/FinanceWorkspace.tsx",
    "apps/web/app/components/FinanceExceptionWorkspace.tsx",
    "apps/web/app/components/WarehouseWorkspace.tsx",
  ].map((path) => readFile(new URL(path, root), "utf8")));
  const joined = frontend.join("\n");
  assert.doesNotMatch(joined, /["'`]\/api\/(?:approvals|inventory|production-orders|quality-inspections|stocktakes|shipments|returns|finance|warehouses)(?:["'`/])/u);
  assert.match(joined, /mutateJson\("\/api\/v1\/approvals"/u);
  assert.match(joined, /mutateJson\("\/api\/v1\/finance"/u);
});

test("Operations stays inside Scope A boundaries", async () => {
  const sources = await Promise.all([
    "apps/api/src/modules/production-orders/writes.ts",
    "apps/api/src/modules/shipments/writes.ts",
    "apps/api/src/modules/finance/writes.ts",
  ].map((path) => readFile(new URL(path, root), "utf8")));
  const joined = sources.join("\n");
  assert.doesNotMatch(joined, /(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+`?(?:purchase_receipts|payment_instructions|receiver_orgs)`?/iu);
  // The Scope A business-closure couples a production order's BOM material
  // lines with its inventory reservation; every ledger transition must stay
  // CAS-guarded rather than being a direct projection rewrite.
  assert.match(joined, /reserved_quantity\s*=\s*reserved_quantity\s*-\s*\?/u);
  assert.match(joined, /locked_quantity\s*=\s*locked_quantity\s*-\s*\?/u);
  assert.match(joined, /inbound_pending_inspection/u);
  assert.doesNotMatch(joined, /quality_inspection[\s\S]{0,300}available_quantity\s*=\s*available_quantity\s*\+/iu);
});

test("Operations domain events use the shared generic worker contract", async () => {
  const [support, worker] = await Promise.all([
    readFile(new URL("apps/api/src/platform/operations-support.ts", root), "utf8"),
    readFile(new URL("apps/worker/src/server.ts", root), "utf8"),
  ]);
  assert.match(support, /topic: "domain\.event"/u);
  assert.doesNotMatch(support, /topic: "notification\.dispatch"/u);
  assert.match(worker, /case "domain\.event"/u);
  assert.match(worker, /requireDomainEvent/u);
});

test("bounded A-J guards are represented in contracts, locks, ACLs and UI", async () => {
  const [approval, finance, production, logistics, returns, stocktakes, stocktakeSupport, fileSupport, command, contract, client, page, shipping, sql] = await Promise.all([
    "apps/api/src/modules/approvals/writes.ts", "apps/api/src/modules/finance/writes.ts",
    "apps/api/src/modules/production-orders/writes.ts", "apps/api/src/modules/shipments/writes.ts",
    "apps/api/src/modules/returns/writes.ts", "apps/api/src/modules/stocktakes/writes.ts",
    "apps/api/src/modules/stocktakes/support.ts", "apps/api/src/modules/files/support.ts",
    "apps/api/src/platform/operations-command.ts",
    "packages/contracts/src/operations-writes.ts", "apps/web/app/lib/mutation-client.ts", "apps/web/app/page.tsx",
    "apps/web/app/components/ShippingWorkspace.tsx", "database/migrations/mysql/0004_scope_a_domain_writes.sql",
  ].map((path) => readFile(new URL(path, root), "utf8")));
  assert.match(approval, /r1\.user_role_change/u);
  assert.match(approval, /`r2\.\$\{workflow\}`/u);
  assert.match(approval, /resource_type = 'approval_request'.+FOR UPDATE/su);
  assert.match(sql, /corrects_payment_record_id/u);
  assert.ok(
    sql.indexOf("ADD COLUMN `corrects_payment_record_id`") < sql.indexOf("CREATE UNIQUE INDEX `r3_payment_record_reversal_unique`"),
    "legacy correction rows must be split before reversal uniqueness is enforced",
  );
  assert.match(sql, /SET `corrects_payment_record_id` = `reverses_payment_record_id`,[\s\S]+WHERE `record_type` = 'correction'/u);
  assert.match(production, /purchase_plan_order_links[\s\S]+purchase_plan_items[\s\S]+FOR UPDATE/u);
  assert.match(logistics, /shipment_receipts/u);
  assert.match(logistics, /FOR UPDATE/u);
  assert.match(returns, /Disposition exceeds authoritative inspection buckets/u);
  assert.match(finance, /invoice_payment_allocations[\s\S]+FOR UPDATE/u);
  assert.match(finance, /status = 'received'/u);
  assert.match(stocktakes, /snapshotAvailable[\s\S]+snapshotLocked[\s\S]+snapshotDefective[\s\S]+snapshotPendingInspection/u);
  assert.match(stocktakes, /round1CountedBy/u);
  assert.match(stocktakeSupport, /s\.scope = 'full_warehouse'/u);
  assert.match(fileSupport, /category, entity_type AS entityType, entity_id AS entityId/u);
  assert.match(command, /return `user:\$\{access\.userId\}`/u);
  assert.match(client, /response\.status === 502.+NETWORK_OUTCOME_UNKNOWN/su);
  assert.match(contract, /actualFinishedQuantity: quantity/u);
  assert.match(page, /selected\.approvalOwner === "r2"/u);
  assert.match(shipping, /receiverOnly[\s\S]+Receiver 权威组织模型/u);
  assert.match(approval, /invoice_payment_allocations[\s\S]+ORDER BY payment_request_id ASC FOR UPDATE/u);
  assert.match(approval, /row\.invoiceExceptionId === null \? sum \+ amount : sum/u);
  assert.match(approval, /WHERE id = \? AND status = \? AND refunded_amount_minor = \?/u);
});

test("production completion accepts zero so underproduction reaches the domain handler", async (t) => {
  const app = await buildRuntimeApp({ logger:false, registrationManifests:[operationsManifest], environment:{ NODE_ENV:"test" } });
  t.after(() => app.close());
  const response = await app.inject({ method:"PATCH", url:"/api/v1/production-orders",
    headers:{ "idempotency-key":randomUUID() }, payload:{ id:1, action:"complete", actualFinishedQuantity:0 } });
  assert.notEqual(response.statusCode, 400, response.body);
});
