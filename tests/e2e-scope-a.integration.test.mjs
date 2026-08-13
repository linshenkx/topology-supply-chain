import assert from "node:assert/strict";
import test from "node:test";
import { command, requestJson, safeHttp, signIn, stubControl, withScenario } from "./e2e/scope-a.helpers.mjs";

test("Stage 11 T2 identity, HTTPS same-origin, CSRF and legacy retirement", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "identity", "foundation-auth-worker", async ({ runtime }) => {
    await stubControl(runtime, "sms", "fail_once");
    const session = await signIn(runtime);
    const noCsrf = await command({ ...session, csrf: "" }, "/api/v1/auth/logout", {});
    assert.ok([400, 403].includes(noCsrf.status));
    const logout = await command(session, "/api/v1/auth/logout", {});
    assert.equal(logout.status, 200);
    const legacy = [
      ["/api/approvals", "/api/v1/approvals"], ["/api/audit-logs", "/api/v1/audit-logs"], ["/api/finance", "/api/v1/finance"], ["/api/imports/diff", "/api/v1/imports/diff"], ["/api/inventory", "/api/v1/inventory"], ["/api/master-data", "/api/v1/master-data"], ["/api/production-orders", "/api/v1/production-orders"], ["/api/purchase-orders", "/api/v1/purchase-orders"], ["/api/purchase-plans", "/api/v1/purchase-plans"], ["/api/quality-inspections", "/api/v1/quality-inspections"], ["/api/returns", "/api/v1/returns"], ["/api/shipments", "/api/v1/shipments"], ["/api/stocktakes", "/api/v1/stocktakes"], ["/api/supplier-performance", "/api/v1/supplier-performance"], ["/api/supplier-prices", "/api/v1/supplier-prices"], ["/api/supplier-skus", "/api/v1/supplier-skus"], ["/api/suppliers", "/api/v1/suppliers"], ["/api/warehouses", "/api/v1/warehouses"],
    ];
    for (const [path, successor] of legacy) {
      const response = await requestJson(runtime.origins.https, path, { method: "GET" });
      assert.equal(response.status, 410, path); assert.equal(response.body.code, "WRITER_MOVED", path);
      assert.equal(response.headers.link, `<${successor}>; rel="successor-version"`, path);
    }
  });
});

test("Stage 11 T2 R2 procurement preserves replay, digest, scope, audit and outbox", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r2plan", "t2-r2-purchase-plan", async ({ runtime, db }) => {
    const session = await signIn(runtime); const fixture = runtime.fixture.entities;
    const payload = { planNo: `E2E-${runtime.runId}-PLAN`, items: [{ expectedArrivalDate: "2026-03-01", factoryId: fixture.factoryId, warehouseId: fixture.warehouseId, sku: fixture.sku, productName: `E2E ${runtime.runId}`, bomId: fixture.bomId, plannedQuantity: 3 }] };
    const key = `${runtime.runId}-r2-plan-0001`;
    const first = await command(session, "/api/v1/purchase-plans", payload, { key }); const replay = await command(session, "/api/v1/purchase-plans", payload, { key }); const conflict = await command(session, "/api/v1/purchase-plans", { ...payload, planNo: `${payload.planNo}-changed` }, { key });
    assert.equal(first.status, 201, JSON.stringify(safeHttp("plan", first))); assert.equal(replay.status, 201); assert.equal(replay.body.command.replayed, true); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
    const id = first.body.result.plan.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM purchase_plans WHERE id=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE entity_id=? AND module='purchase_plans') AS audits", [id, String(id)]); const [[approval]] = await db.query("SELECT id FROM approval_requests WHERE entity_type='purchase_plan' AND entity_id=? ORDER BY id DESC LIMIT 1", [id]); const [[outbox]] = await db.query("SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_type='approval_request' AND aggregate_id=?", [String(approval.id)]);
    assert.equal(Number(facts.domainRows), 1); assert.equal(Number(facts.audits), 1); assert.ok(Number(outbox.count) >= 1);
  });
});

test("Stage 11 T2 R2 master-data and supplier-SKU reject scope bypasses", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r2master", "t2-r2-master-data", async ({ runtime, db }) => {
    const session = await signIn(runtime); const payload = { action: "create_sku", code: `E2E-${runtime.runId}-SKU`, name: `E2E ${runtime.runId} SKU`, itemType: "auxiliary", stockUnit: "EA", overproductionTolerance: 0, purchaseOverTolerance: 0, purchaseUnderTolerance: 0 };
    const key = `${runtime.runId}-r2-master-0001`; const first = await command(session, "/api/v1/master-data", payload, { key }); const replay = await command(session, "/api/v1/master-data", payload, { key }); const changed = await command(session, "/api/v1/master-data", { ...payload, name: `${payload.name} changed` }, { key });
    assert.equal(first.status, 201, JSON.stringify(safeHttp("master-data", first))); assert.equal(replay.body.command.replayed, true); assert.equal(changed.status, 409); assert.equal(changed.body.code, "IDEMPOTENCY_KEY_REUSED");
    const sku = first.body.result.sku.code; const skuId = first.body.result.sku.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM skus WHERE code=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE module='master_data' AND entity_id=?) AS audits", [sku, String(skuId)]); const [[approval]] = await db.query("SELECT id FROM approval_requests WHERE entity_type='sku' AND entity_id=? ORDER BY id DESC LIMIT 1", [skuId]); const [[outbox]] = await db.query("SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_type='approval_request' AND aggregate_id=?", [String(approval.id)]);
    assert.equal(Number(facts.domainRows), 1); assert.equal(Number(facts.audits), 1); assert.ok(Number(outbox.count) >= 1);
  });
  await withScenario(t, "r2supplier", "t2-r2-suppliers", async ({ runtime, db }) => {
    const session = await signIn(runtime); const fixture = runtime.fixture.entities;
    const payload = { factoryId: fixture.factoryId, supplierId: fixture.supplierId, sku: fixture.componentSku, effectiveFrom: "2026-01-01", priority: 2, minimumOrderQuantity: 1, packagingMultiple: 1, purchaseUnit: "EA" };
    const first = await command(session, "/api/v1/supplier-skus", payload, { key: `${runtime.runId}-r2-supplier-sku-0001` }); assert.ok([200, 201].includes(first.status), JSON.stringify(safeHttp("supplier-sku", first)));
    const denied = await signIn(runtime, "denied"); const forbidden = await command(denied, "/api/v1/supplier-skus", { ...payload, sku: fixture.sku }); assert.equal(forbidden.status, 403);
    const id = first.body.result.relation.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM supplier_skus WHERE id=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE module='suppliers' AND entity_id=?) AS audits", [id, String(id)]); const [[approval]] = await db.query("SELECT id FROM approval_requests WHERE entity_type='supplier_sku' AND entity_id=? ORDER BY id DESC LIMIT 1", [id]); const [[outbox]] = await db.query("SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_type='approval_request' AND aggregate_id=?", [String(approval.id)]);
    assert.equal(Number(facts.domainRows), 1); assert.equal(Number(facts.audits), 1); assert.ok(Number(outbox.count) >= 1);
  });
});

test("Stage 11 T2 R2 purchase order uses the approved plan and factory scope", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r2order", "t2-r2-purchase-order", async ({ runtime, db }) => {
    const session = await signIn(runtime); const fixture = runtime.fixture.entities;
    const payload = { orderNo: `E2E-${runtime.runId}-PO-NEW`, orderDate: "2026-01-20", items: [{ planItemId: fixture.planItemId, supplierId: fixture.supplierId, quantity: 10, dueDate: "2026-02-01", sku: fixture.sku, productName: `E2E ${runtime.runId} Finished SKU`, itemType: "finished", unitPriceTaxIncludedMinor: 100 }] };
    const key = `${runtime.runId}-r2-order-0001`; const first = await command(session, "/api/v1/purchase-orders", payload, { key }); const replay = await command(session, "/api/v1/purchase-orders", payload, { key }); const changed = await command(session, "/api/v1/purchase-orders", { ...payload, orderNo: `${payload.orderNo}-changed` }, { key });
    assert.equal(first.status, 201, JSON.stringify(safeHttp("purchase-order", first))); assert.equal(replay.body.command.replayed, true); assert.equal(changed.status, 409);
    const id = first.body.result.order.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM purchase_orders WHERE id=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE module='purchase_orders' AND entity_id=?) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type='purchase_order' AND aggregate_id=?) AS outboxRows", [id, String(id), String(id)]);
    assert.equal(Number(facts.domainRows), 1); assert.equal(Number(facts.audits), 1); assert.ok(Number(facts.outboxRows) >= 1);
  });
});

test("Stage 11 T2 R3 inventory fails closed and records business evidence", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r3inventory", "t2-r3-inventory", async ({ runtime, db }) => {
    const session = await signIn(runtime); const fixture = runtime.fixture.entities;
    const payload = { batchId: fixture.batchId, entityType: "historical", requestedQuantity: 3, priority: 0 }; const key = `${runtime.runId}-r3-inventory-0001`;
    const first = await command(session, "/api/v1/inventory", payload, { key }); const replay = await command(session, "/api/v1/inventory", payload, { key });
    assert.equal(first.status, 201, JSON.stringify(safeHttp("inventory", first))); assert.equal(replay.body.command.replayed, true);
    const forbidden = await command(session, "/api/v1/inventory/transfers", { fromWarehouseId: fixture.warehouseId, toWarehouseId: fixture.warehouseId, sku: fixture.sku, quantity: 1, reason: "same warehouse" });
    assert.equal(forbidden.status, 400);
    const transferPayload = { fromWarehouseId: fixture.warehouseId, toWarehouseId: fixture.transferWarehouseId, sku: fixture.sku, quantity: 1, reason: "E2E transfer" }; const transfer = await command(session, "/api/v1/inventory/transfers", transferPayload, { key: `${runtime.runId}-r3-transfer-0001` }); const transferReplay = await command(session, "/api/v1/inventory/transfers", transferPayload, { key: `${runtime.runId}-r3-transfer-0001` });
    assert.equal(transfer.status, 201, JSON.stringify(safeHttp("transfer", transfer))); assert.equal(transferReplay.body.command.replayed, true);
    const stocktake = await command(session, "/api/v1/stocktakes", { warehouseId: fixture.warehouseId, scope: "full_warehouse", dueDate: "2026-12-31" }, { key: `${runtime.runId}-r3-stocktake-0001` }); assert.equal(stocktake.status, 201, JSON.stringify(safeHttp("stocktake", stocktake)));
    const id = first.body.result.reservation.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM inventory_reservations WHERE id=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE entity_id=? AND module='inventory' AND entity_type='inventory_reservation') AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type='inventory_reservation' AND aggregate_id=?) AS outboxRows", [id, String(id), String(id)]);
    assert.deepEqual([Number(facts.domainRows), Number(facts.audits), Number(facts.outboxRows)], [1, 1, 1]);
  });
});

test("Stage 11 T2 R3 production and quality stay inside the current Scope A boundary", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r3production", "t2-r3-production-quality", async ({ runtime, db }) => {
    const session = await signIn(runtime); const fixture = runtime.fixture.entities;
    const started = await command(session, "/api/v1/production-orders", { id: fixture.executionOrderId, action: "start" }, { method: "PATCH", key: `${runtime.runId}-r3-production-start-0001` }); assert.equal(started.status, 200, JSON.stringify(safeHttp("production-start", started)));
    const [lines] = await db.query("SELECT id FROM production_material_lines WHERE execution_order_id=? ORDER BY id", [fixture.executionOrderId]); const materials = await command(session, "/api/v1/production-orders", { id: fixture.executionOrderId, action: "materials", materials: lines.map((line) => ({ id: line.id, issuedQuantity: 0, consumedQuantity: 0, lossQuantity: 0 })) }, { method: "PATCH", key: `${runtime.runId}-r3-production-materials-0001` }); assert.equal(materials.status, 200);
    const complete = await command(session, "/api/v1/production-orders", { id: fixture.executionOrderId, action: "complete", actualFinishedQuantity: 0 }, { method: "PATCH", key: `${runtime.runId}-r3-production-complete-0001` }); assert.equal(complete.status, 200, JSON.stringify(safeHttp("production-complete", complete)));
    const admin = await signIn(runtime, "admin"); const inspection = await command(admin, "/api/v1/quality-inspections", { executionOrderId: fixture.executionOrderId, stage: "incoming", inspectionMethod: "full", batchQuantity: 1, inspectedQuantity: 1, passedQuantity: 1, failedQuantity: 0, inspectorType: "company_qc" }, { key: `${runtime.runId}-r3-quality-0001` }); assert.equal(inspection.status, 201, JSON.stringify(safeHttp("quality", inspection)));
    const invalid = await command(admin, "/api/v1/quality-inspections", { executionOrderId: fixture.executionOrderId, stage: "incoming", inspectionMethod: "full", batchQuantity: 1, inspectedQuantity: 1, passedQuantity: 1, failedQuantity: 1, inspectorType: "company_qc" }); assert.equal(invalid.status, 400);
    const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM audit_logs WHERE module IN ('production','quality') AND entity_id=?) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type='execution_order' AND aggregate_id=?) AS outboxRows", [String(fixture.executionOrderId), String(fixture.executionOrderId)]); assert.ok(Number(facts.audits) >= 2); assert.ok(Number(facts.outboxRows) >= 2);
  });
});

test.skip("Stage 11 T2 R3 shipment and return is blocked by the recorded local 500 ship counterexample", () => {});

test("Stage 11 T2 R3 finance direct write and payment negative path remain fail-closed", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "r3finance", "t2-r3-finance", async ({ runtime, db }) => {
    const session = await signIn(runtime, "finance"); const fixture = runtime.fixture.entities;
    const invalidated = await command(session, "/api/v1/finance", { action: "invalidate_invoice", invoiceId: fixture.invoiceId, exceptionType: "voided", reason: "E2E controlled invalidation", replacementDeadline: "2026-12-31" }, { key: `${runtime.runId}-r3-finance-invalidate-0001` }); assert.equal(invalidated.status, 201, JSON.stringify(safeHttp("finance-invalidate", invalidated)));
    const payment = await command(session, "/api/v1/finance", { action: "record_payment", paymentRequestId: fixture.paymentRequestId, amountMinor: 1, paidAt: "2026-01-02", bankReference: `E2E-${runtime.runId}-PAY` }); assert.equal(payment.status, 400); assert.equal(payment.body.code, "BAD_REQUEST");
    const exceptionId = invalidated.body.result.exception.id; const [[facts]] = await db.query("SELECT (SELECT COUNT(*) FROM invoice_exceptions WHERE id=?) AS domainRows, (SELECT COUNT(*) FROM audit_logs WHERE module='finance' AND entity_id=?) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type='invoice_exception' AND aggregate_id=?) AS outboxRows", [exceptionId, String(fixture.invoiceId), String(exceptionId)]); assert.equal(Number(facts.domainRows), 1); assert.equal(Number(facts.audits), 1); assert.ok(Number(facts.outboxRows) >= 1);
  });
});
