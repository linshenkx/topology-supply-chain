import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildApp } from "../dist/app.js";
import { createDatabaseClient } from "../dist/infrastructure/database.js";
import manifest from "../dist/composition/supply-writes-manifest.js";
import { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "../dist/platform/approvals.js";
import { requireWriterFence } from "../dist/platform/commands.js";
import { enqueueOutbox } from "../dist/platform/outbox.js";
import { FileAuthorizationRegistry } from "../dist/platform/registrations.js";

const databaseUrl = process.env.MYSQL_SUPPLY_TEST_URL?.trim();
const workerEntry = fileURLToPath(new URL("../../worker/dist/server.js", import.meta.url));
const TOKEN = "ef".repeat(32);

function headers(key) {
  return {
    host: "localhost",
    origin: "http://localhost",
    "x-forwarded-proto": "http",
    cookie: `topology_csrf=${TOKEN}`,
    "x-csrf-token": TOKEN,
    "idempotency-key": key,
  };
}

function claim(approvalId, reviewerId, action, suffix) {
  return {
    action,
    challengeNo: `r2-revision-effect-${suffix}-${approvalId}-${action}`,
    objectId: String(approvalId),
    objectType: "r2:approval_request",
    objectVersion: 1,
    requestDigest: "12".repeat(32),
    sessionId: 1,
    userId: reviewerId,
  };
}

async function waitForOutbox(db, outboxId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db.query("SELECT status, last_error_code AS errorCode FROM outbox_messages WHERE id = ?", [outboxId]);
    if (rows[0]?.status === "completed" || rows[0]?.status === "dead") return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker did not consume the supply outbox message");
}

async function runActualWorker(db, outboxId) {
  assert.equal(existsSync(workerEntry), true, "build @topology/worker before running the supply acceptance integration");
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, status: "clean" }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DB_SSL: "disabled",
      HOST: "127.0.0.1",
      PORT: "0",
      OTP_SEALING_KEYS_JSON: JSON.stringify({ v1: "34".repeat(32) }),
      SMS_WEBHOOK_URL: `${origin}/sms`, SMS_WEBHOOK_API_KEY: "test", SMS_WEBHOOK_HEALTH_URL: `${origin}/health`,
      EMAIL_WEBHOOK_URL: `${origin}/email`, EMAIL_WEBHOOK_API_KEY: "test", EMAIL_WEBHOOK_HEALTH_URL: `${origin}/health`,
      FILE_SCAN_WEBHOOK_URL: `${origin}/scan`, FILE_SCAN_WEBHOOK_API_KEY: "test", FILE_SCAN_WEBHOOK_HEALTH_URL: `${origin}/health`,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    return await waitForOutbox(db, outboxId);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => provider.close(resolve));
  }
}

test("Supply bounded acceptance revision counterexamples", {
  skip: !databaseUrl && "set MYSQL_SUPPLY_TEST_URL to run supply acceptance integration",
  timeout: 120_000,
}, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  let keySequence = 0;
  const nextKey = (label) => `r2-revision-${label}-${suffix}-${++keySequence}`;
  const db = createDatabaseClient({ env: {
    DATABASE_URL: databaseUrl,
    DB_SSL: "disabled",
    DB_POOL_SIZE: "20",
    DB_QUERY_TIMEOUT_MS: "30000",
    DB_TRANSACTION_TIMEOUT_MS: "30000",
  } });
  const approvalEffects = new ApprovalEffectRegistry();
  let access;
  const app = await buildApp({ logger: false });
  await manifest.register({
    app,
    database: db,
    unitOfWork: (run) => db.transaction(run),
    executeCommand: async () => { throw new Error("Supply must not call platform executeCommand"); },
    requireWriterFence,
    authenticate: async () => access,
    authorize: () => false,
    audit: async () => {},
    enqueueOutbox,
    approvalPolicy: new ApprovalPolicyRegistry(),
    approvalEffects,
    fileAuthorizations: new FileAuthorizationRegistry(),
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await db.close();
  });

  const insert = async (sql, parameters) => {
    const result = await db.execute(sql, parameters);
    assert.ok(result.insertId > 0);
    return result.insertId;
  };
  const requesterId = await insert(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, ?, 'R2 requester', 'supply_chain', 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`r2-requester-${suffix}@example.com`, `138${String(Date.now()).slice(-8)}`],
  );
  const reviewerId = await insert(
    `INSERT INTO users (email, mobile, name, role, organization_name, account_status, created_at, updated_at)
     VALUES (?, ?, 'R2 reviewer', 'supply_chain', 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`r2-reviewer-${suffix}@example.com`, `139${String(Date.now() + 1).slice(-8)}`],
  );
  const factoryId = await insert(
    "INSERT INTO factories (name, code, status, created_at, updated_at) VALUES ('R2 Factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [`R2F-${suffix}`],
  );
  const factoryUserId = await insert(
    `INSERT INTO users (email, mobile, name, role, factory_id, organization_name, account_status, created_at, updated_at)
     VALUES (?, ?, 'R2 factory user', 'factory', ?, 'R2 Factory', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`r2-factory-${suffix}@example.com`, `137${String(Date.now() + 2).slice(-8)}`, factoryId],
  );
  const warehouseId = await insert(
    "INSERT INTO warehouses (code, name, type, factory_id, status, created_at, updated_at) VALUES (?, 'R2 Warehouse', 'factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [`R2W-${suffix}`, factoryId],
  );
  const skuA = `R2-A-${suffix}`;
  const skuB = `R2-B-${suffix}`;
  const skuC = `R2-C-${suffix}`;
  const skuApproval = `R2-APPROVAL-${suffix}`;
  for (const sku of [skuA, skuB, skuC, skuApproval]) {
    await insert(
      `INSERT INTO skus (code, name, item_type, stock_unit, purchase_over_tolerance_bps,
         purchase_under_tolerance_bps, verification_status, status, created_at, updated_at)
       VALUES (?, ?, 'finished', 'pcs', 0, 0, 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [sku, sku],
    );
  }
  const bomId = await insert(
    `INSERT INTO product_boms (finished_sku, version, effective_from, approval_status, active,
       created_by, created_at, updated_at)
     VALUES (?, 'v1', '2090-01-01', 'approved', 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [skuA, requesterId],
  );
  const supplierId = await insert(
    `INSERT INTO suppliers (code, name, tier, legal_name, unified_social_credit_code,
       verification_status, status, created_at, updated_at)
     VALUES (?, 'R2 Supplier', 1, 'R2 Supplier', ?, 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R2S-${suffix}`, `USCC-${suffix}`],
  );
  const relationA = await insert(
    `INSERT INTO supplier_skus (factory_id, supplier_id, sku, purchase_unit, effective_from,
       status, requested_by, reviewed_by, reviewed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pcs', '2090-01-01', 'active', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [factoryId, supplierId, skuA, requesterId, reviewerId],
  );
  const relationB = await insert(
    `INSERT INTO supplier_skus (factory_id, supplier_id, sku, purchase_unit, effective_from,
       status, requested_by, reviewed_by, reviewed_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pcs', '2090-01-01', 'active', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [factoryId, supplierId, skuB, requesterId, reviewerId],
  );
  const evidence = async (label, relationId) => insert(
    `INSERT INTO file_objects (object_key, file_name, content_type, size_bytes, category,
       entity_type, entity_id, owner_user_id, factory_id, scan_status, created_at)
     VALUES (?, ?, 'application/pdf', 32, 'price_evidence', 'supplier_sku', ?, ?, ?, 'clean', CURRENT_TIMESTAMP(3))`,
    [`r2/${suffix}/${label}.pdf`, `${label}.pdf`, String(relationId), requesterId, factoryId],
  );
  const evidenceA = await evidence("evidence-a", relationA);
  const evidenceB1 = await evidence("evidence-b1", relationB);
  const evidenceB2 = await evidence("evidence-b2", relationB);
  await insert(
    `INSERT INTO core_price_agreements (supplier_id, sku, currency,
       unit_price_tax_included_minor, unit_price_tax_excluded_minor, tax_rate_bps,
       effective_from, status, maintained_by, created_at, updated_at)
     VALUES (?, ?, 'CNY', 1000, 900, 1000, '2090-01-01', 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [supplierId, skuA, requesterId],
  );

  const fenceResources = [
    "r2.supplier-performance.write", "r2.supplier-skus.write", "r2.supplier-prices.write",
    "r2.purchase-plans.update", "r2.purchase-orders.create", "r2.purchase-orders.update",
  ];
  for (const resource of fenceResources) {
    await db.execute(
      `INSERT INTO writer_fences (resource, owner, enabled, generation, updated_at)
       VALUES (?, 'fastify-v1', 1, 2, CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE owner = VALUES(owner), enabled = 1, generation = 2, updated_at = CURRENT_TIMESTAMP(3)`,
      [resource],
    );
  }
  await db.execute(
    `UPDATE writer_fences SET owner = 'worker-v1', enabled = 1, generation = 2
     WHERE resource IN ('outbox.worker','reminders.worker','files.worker')`,
  );

  access = { sessionId: 1, userId: requesterId, email: "requester@example.com", name: "R2 requester", roles: ["supply_chain"], factoryId: null, supplierId: null, organizationName: "Topology", localPreview: false };

  await t.test("1/6 generic events retain entity/scope semantics while real approvals use the actual Worker contract", async () => {
    const approvalResponse = await app.inject({
      method: "POST", url: "/api/v1/supplier-skus", headers: headers(nextKey("worker-approval")),
      payload: { factoryId, supplierId, sku: skuApproval, effectiveFrom: "2099-01-01", priority: 1, minimumOrderQuantity: 1, packagingMultiple: 1, purchaseUnit: "pcs" },
    });
    assert.equal(approvalResponse.statusCode, 201, approvalResponse.body);
    const approvalTargetId = approvalResponse.json().result.relation.id;
    let rows = await db.query(
      `SELECT ob.id, ob.topic, ob.aggregate_type AS aggregateType,
              ob.aggregate_id AS aggregateId, ob.payload_json AS payloadJson
       FROM approval_requests ar
       JOIN outbox_messages ob ON ob.aggregate_type = 'approval_request'
         AND ob.aggregate_id = CAST(ar.id AS CHAR)
       WHERE ar.entity_type = 'supplier_sku' AND ar.entity_id = ?
       ORDER BY ob.id DESC LIMIT 1`,
      [approvalTargetId],
    );
    const approvalPayload = JSON.parse(rows[0].payloadJson);
    assert.equal(rows[0].topic, "notification.dispatch");
    assert.equal(rows[0].aggregateType, "approval_request");
    assert.equal(rows[0].aggregateId, String(approvalPayload.approvalId));
    assert.deepEqual(approvalPayload, {
      approvalId: approvalPayload.approvalId,
      recipientRole: "supply_chain",
      type: "supplier_sku_change",
      targetEntityType: "supplier_sku",
      targetEntityId: String(approvalTargetId),
    });
    const terminal = await runActualWorker(db, rows[0].id);
    assert.deepEqual(terminal, { status: "completed", errorCode: null });

    const response = await app.inject({
      method: "POST", url: "/api/v1/supplier-performance", headers: headers(nextKey("worker")),
      payload: { action: "weights", tier: 1, effectiveFrom: "2099-01-01", delivery: 25, quality: 20, exception: 15, preparation: 10, satisfaction: 15, sampling: 15 },
    });
    assert.equal(response.statusCode, 200, response.body);
    const entityId = response.json().result.weightId;
    rows = await db.query(
      `SELECT topic, aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              payload_json AS payloadJson FROM outbox_messages
       WHERE aggregate_type = 'performance_weights' AND aggregate_id = ? ORDER BY id DESC LIMIT 1`,
      [String(entityId)],
    );
    const payload = JSON.parse(rows[0].payloadJson);
    assert.equal(rows[0].topic, "domain.event");
    assert.equal(rows[0].aggregateType, "performance_weights");
    assert.equal(rows[0].aggregateId, String(entityId));
    assert.deepEqual(payload, {
      schemaVersion: 1,
      entityType: "performance_weights",
      entityId: String(entityId),
      eventType: "SupplierPerformanceWeightsChanged",
      recipient: { kind: "role", role: "supply_chain" },
      data: { tier: 1, effectiveFrom: "2099-01-01" },
    });
    for (const forbiddenField of ["approvalId", "recipientRole", "type"]) assert.equal(forbiddenField in payload, false);
  });

  const createPlan = async (planNo, version, status, quantity = 10) => {
    const planId = await insert(
      `INSERT INTO purchase_plans (plan_no, version, source, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'manual', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [planNo, version, status, requesterId],
    );
    const itemId = await insert(
      `INSERT INTO purchase_plan_items (purchase_plan_id, expected_arrival_date, factory_id,
         warehouse_id, sku, product_name, bom_id, planned_quantity, ordered_quantity,
         over_tolerance_bps, under_tolerance_bps, completion_status, created_at, updated_at)
       VALUES (?, '2099-08-20', ?, ?, ?, 'R2 Product', ?, ?, 0, 0, 0, 'not_ordered', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [planId, factoryId, warehouseId, skuA, bomId, quantity],
    );
    const rows = await db.query("SELECT updated_at AS updatedAt FROM purchase_plans WHERE id = ?", [planId]);
    return { itemId, planId, updatedAt: rows[0].updatedAt };
  };

  await t.test("2/6 purchase-plan gates reject pending/old revisions and CAS concurrent factory responses", async () => {
    const pending = await createPlan(`PENDING-${suffix}`, 1, "pending_approval");
    const old = await createPlan(`LATEST-${suffix}`, 1, "confirmed");
    await createPlan(`LATEST-${suffix}`, 2, "pending_approval");
    const awaiting = await createPlan(`AWAIT-${suffix}`, 1, "awaiting_factory_confirmation");

    access = { ...access, userId: factoryUserId, roles: ["factory"], factoryId };
    const factoryPending = await app.inject({ method: "PATCH", url: "/api/v1/purchase-plans", headers: headers(nextKey("pending-confirm")), payload: { id: pending.planId, expectedUpdatedAt: pending.updatedAt, decision: "confirmed", expectedStartDate: "2099-08-13", expectedFinishDate: "2099-08-14" } });
    assert.equal(factoryPending.statusCode, 409, factoryPending.body);
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const finalizePending = await app.inject({ method: "PATCH", url: "/api/v1/purchase-plans", headers: headers(nextKey("pending-finalize")), payload: { id: pending.planId, expectedUpdatedAt: pending.updatedAt, action: "finalize_ordering" } });
    assert.equal(finalizePending.statusCode, 409, finalizePending.body);
    const orderPending = await app.inject({ method: "POST", url: "/api/v1/purchase-orders", headers: headers(nextKey("pending-order")), payload: { orderNo: `PO-PENDING-${suffix}`, orderDate: "2099-08-12", items: [{ planItemId: pending.itemId, supplierId, quantity: 1, dueDate: "2099-08-20", sku: skuA, productName: "R2 Product", itemType: "finished" }] } });
    assert.equal(orderPending.statusCode, 409, orderPending.body);
    const oldVersionOrder = await app.inject({ method: "POST", url: "/api/v1/purchase-orders", headers: headers(nextKey("old-plan")), payload: { orderNo: `PO-OLD-${suffix}`, orderDate: "2099-08-12", items: [{ planItemId: old.itemId, supplierId, quantity: 1, dueDate: "2099-08-20", sku: skuA, productName: "R2 Product", itemType: "finished" }] } });
    assert.equal(oldVersionOrder.statusCode, 409, oldVersionOrder.body);

    access = { ...access, userId: factoryUserId, roles: ["factory"], factoryId };
    const responsePayload = { id: awaiting.planId, expectedUpdatedAt: awaiting.updatedAt, decision: "confirmed", expectedStartDate: "2099-08-13", expectedFinishDate: "2099-08-14" };
    const raced = await Promise.all([
      app.inject({ method: "PATCH", url: "/api/v1/purchase-plans", headers: headers(nextKey("factory-race-a")), payload: responsePayload }),
      app.inject({ method: "PATCH", url: "/api/v1/purchase-plans", headers: headers(nextKey("factory-race-b")), payload: responsePayload }),
    ]);
    assert.deepEqual(raced.map((response) => response.statusCode).sort(), [200, 409]);
  });

  await t.test("3/6 over-tolerance PO is non-executable until approval and rejection is terminal", async () => {
    const approvedPlan = await createPlan(`OVER-APP-${suffix}`, 1, "confirmed");
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const created = await app.inject({ method: "POST", url: "/api/v1/purchase-orders", headers: headers(nextKey("over-create")), payload: { orderNo: `PO-OVER-${suffix}`, orderDate: "2099-08-12", items: [{ planItemId: approvedPlan.itemId, supplierId, quantity: 11, dueDate: "2099-08-20", sku: skuA, productName: "R2 Product", itemType: "finished" }] } });
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json().result.order.id;
    assert.equal(created.json().result.order.status, "pending_approval");
    let rows = await db.query("SELECT COUNT(*) AS count FROM reminder_schedules WHERE entity_type = 'purchase_order' AND entity_id = ?", [orderId]);
    assert.equal(Number(rows[0].count), 0);
    rows = await db.query("SELECT updated_at AS updatedAt FROM purchase_orders WHERE id = ?", [orderId]);
    access = { ...access, userId: factoryUserId, roles: ["factory"], factoryId };
    const premature = await app.inject({ method: "PATCH", url: "/api/v1/purchase-orders", headers: headers(nextKey("over-premature")), payload: { id: orderId, expectedUpdatedAt: rows[0].updatedAt, decision: "confirmed" } });
    assert.equal(premature.statusCode, 409, premature.body);
    const approvals = await db.query("SELECT id FROM approval_requests WHERE entity_type = 'purchase_order' AND entity_id = ? AND workflow_type = 'purchase_plan_deviation' ORDER BY id", [orderId]);
    const effect = approvalEffects.resolve("r2.purchase_plan_deviation");
    const outcomes = await Promise.allSettled([
      db.transaction((transaction) => effect.execute({ transaction, claim: claim(approvals[0].id, reviewerId, "approve", suffix) })),
      db.transaction((transaction) => effect.execute({ transaction, claim: claim(approvals[0].id, reviewerId, "approve", suffix) })),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    rows = await db.query("SELECT status FROM purchase_orders WHERE id = ?", [orderId]);
    assert.equal(rows[0].status, "factory_confirmation");
    rows = await db.query("SELECT COUNT(*) AS count FROM reminder_schedules WHERE entity_type = 'purchase_order' AND entity_id = ?", [orderId]);
    assert.equal(Number(rows[0].count), 1);

    const rejectedPlan = await createPlan(`OVER-REJ-${suffix}`, 1, "confirmed");
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const rejectedCreated = await app.inject({ method: "POST", url: "/api/v1/purchase-orders", headers: headers(nextKey("over-reject-create")), payload: { orderNo: `PO-REJECT-${suffix}`, orderDate: "2099-08-12", items: [{ planItemId: rejectedPlan.itemId, supplierId, quantity: 11, dueDate: "2099-08-20", sku: skuA, productName: "R2 Product", itemType: "finished" }] } });
    assert.equal(rejectedCreated.statusCode, 201, rejectedCreated.body);
    const rejectedOrderId = rejectedCreated.json().result.order.id;
    const rejectedApprovals = await db.query("SELECT id FROM approval_requests WHERE entity_type = 'purchase_order' AND entity_id = ? AND workflow_type = 'purchase_plan_deviation'", [rejectedOrderId]);
    await db.transaction((transaction) => effect.execute({ transaction, claim: claim(rejectedApprovals[0].id, reviewerId, "reject", suffix) }));
    rows = await db.query("SELECT status, updated_at AS updatedAt FROM purchase_orders WHERE id = ?", [rejectedOrderId]);
    assert.equal(rows[0].status, "approval_rejected");
    const rejectedUpdatedAt = rows[0].updatedAt;
    rows = await db.query("SELECT COUNT(*) AS count FROM reminder_schedules WHERE entity_type = 'purchase_order' AND entity_id = ?", [rejectedOrderId]);
    assert.equal(Number(rows[0].count), 0);
    access = { ...access, userId: factoryUserId, roles: ["factory"], factoryId };
    const terminal = await app.inject({ method: "PATCH", url: "/api/v1/purchase-orders", headers: headers(nextKey("over-terminal")), payload: { id: rejectedOrderId, expectedUpdatedAt: rejectedUpdatedAt, decision: "confirmed" } });
    assert.equal(terminal.statusCode, 409, terminal.body);
  });

  await t.test("4/6 stale supplier-SKU approval cannot activate a later in-place revision", async () => {
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const base = { factoryId, supplierId, sku: skuC, effectiveFrom: "2099-01-01", priority: 1, minimumOrderQuantity: 1, packagingMultiple: 1, purchaseUnit: "pcs" };
    const first = await app.inject({ method: "POST", url: "/api/v1/supplier-skus", headers: headers(nextKey("sku-first")), payload: base });
    assert.equal(first.statusCode, 201, first.body);
    const relationId = first.json().result.relation.id;
    const second = await app.inject({ method: "POST", url: "/api/v1/supplier-skus", headers: headers(nextKey("sku-second")), payload: { ...base, priority: 2 } });
    assert.equal(second.statusCode, 200, second.body);
    const approvals = await db.query("SELECT id FROM approval_requests WHERE entity_type = 'supplier_sku' AND entity_id = ? ORDER BY id", [relationId]);
    const effect = approvalEffects.resolve("r2.supplier_sku_change");
    await assert.rejects(
      db.transaction((transaction) => effect.execute({ transaction, claim: claim(approvals[0].id, reviewerId, "approve", suffix) })),
      (error) => error.code === "CONFLICT",
    );
    await db.transaction((transaction) => effect.execute({ transaction, claim: claim(approvals[1].id, reviewerId, "approve", suffix) }));
    const rows = await db.query("SELECT priority, status FROM supplier_skus WHERE id = ?", [relationId]);
    assert.deepEqual(rows[0], { priority: 2, status: "active" });
  });

  await t.test("5/6 concurrent first-price approvals serialize on the supplier/SKU version", async () => {
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const price = (evidenceFileKey, effectiveFrom, amount) => ({ supplierId, sku: skuB, taxIncludedMinor: amount, taxExcludedMinor: amount - 100, taxRateBps: 1000, effectiveFrom, reason: "Supply acceptance", evidenceFileKey: String(evidenceFileKey) });
    const first = await app.inject({ method: "POST", url: "/api/v1/supplier-prices", headers: headers(nextKey("price-first")), payload: price(evidenceB1, "2099-02-01", 1200) });
    const second = await app.inject({ method: "POST", url: "/api/v1/supplier-prices", headers: headers(nextKey("price-second")), payload: price(evidenceB2, "2099-03-01", 1300) });
    assert.deepEqual([first.statusCode, second.statusCode], [201, 201], `${first.body}\n${second.body}`);
    const requestIds = [first.json().result.request.id, second.json().result.request.id];
    const approvals = await db.query(`SELECT id, entity_id AS entityId FROM approval_requests WHERE entity_type = 'supplier_price_change' AND entity_id IN (?, ?) ORDER BY id`, requestIds);
    const effect = approvalEffects.resolve("r2.supplier_price_change");
    const outcomes = await Promise.allSettled(approvals.map((approval) => db.transaction((transaction) => effect.execute({ transaction, claim: claim(approval.id, reviewerId, "approve", suffix) }))));
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    const failedIndex = outcomes.findIndex((outcome) => outcome.status === "rejected");
    await assert.rejects(
      db.transaction((transaction) => effect.execute({ transaction, claim: claim(approvals[failedIndex].id, reviewerId, "approve", `${suffix}-sequential`) })),
      (error) => error.code === "CONFLICT",
    );
    const rows = await db.query("SELECT COUNT(*) AS count FROM core_price_agreements WHERE supplier_id = ? AND sku = ? AND status = 'active'", [supplierId, skuB]);
    assert.equal(Number(rows[0].count), 1);
  });

  await t.test("6/6 internal price evidence cannot cross supplier-SKU objects", async () => {
    access = { ...access, userId: requesterId, roles: ["supply_chain"], factoryId: null };
    const response = await app.inject({
      method: "POST", url: "/api/v1/supplier-prices", headers: headers(nextKey("cross-evidence")),
      payload: { supplierId, sku: skuB, taxIncludedMinor: 1400, taxExcludedMinor: 1300, taxRateBps: 1000, effectiveFrom: "2099-04-01", reason: "cross-object evidence must fail", evidenceFileKey: String(evidenceA) },
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().message, "File entity binding rejected");
  });
});
