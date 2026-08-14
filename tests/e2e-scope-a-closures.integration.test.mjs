import assert from "node:assert/strict";
import test from "node:test";

import { command, requestJson, safeHttp, signIn, withScenario } from "./e2e/scope-a.helpers.mjs";

test("Stage 11 T2 Scope A business closures: purchase receipt -> batch quality -> production reserve/consume/release", { timeout: 720_000 }, async (t) => {
  await withScenario(t, "operations-closures", "t2-operations-scope-a-closures", async ({ runtime, db }) => {
    const fixture = runtime.fixture.entities;
    const session = await signIn(runtime);
    const admin = await signIn(runtime, "admin");
    const finance = await signIn(runtime, "finance");

    const receiptPayload = {
      purchaseOrderId: fixture.purchaseOrderId,
      orderItemId: fixture.orderItemId,
      warehouseId: fixture.warehouseId,
      receivedQuantity: 10,
    };
    const receiptKey = runtime.runId + "-r3-receipt-0001";
    const receipt = await command(session, "/api/v1/purchase-receipts", receiptPayload, { key: receiptKey });
    assert.equal(receipt.status, 201, JSON.stringify(safeHttp("receipt", receipt)));
    const receiptBatchId = receipt.body.result.receipt.batchId;
    const receiptId = receipt.body.result.receipt.id;

    const replay = await command(session, "/api/v1/purchase-receipts", receiptPayload, { key: receiptKey });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.command.replayed, true);

    const duplicate = await command(session, "/api/v1/purchase-receipts", receiptPayload);
    assert.equal(duplicate.status, 409);

    const [secondInsert] = await db.execute(
      "INSERT INTO order_items (purchase_order_id, sku, product_name, item_type, quantity, received_quantity, unit_price_tax_included_minor, amount_tax_included_minor, due_date) VALUES (?, ?, 'E2E second finished item', 'finished', 4, 0, 100, 400, '2026-02-01')",
      [fixture.purchaseOrderId, fixture.sku],
    );
    const secondOrderItemId = secondInsert.insertId;
    const partialPayload = {
      purchaseOrderId: fixture.purchaseOrderId,
      orderItemId: secondOrderItemId,
      warehouseId: fixture.warehouseId,
      receivedQuantity: 2,
    };
    const partial = await command(session, "/api/v1/purchase-receipts", partialPayload);
    assert.equal(partial.status, 400);

    const forbiddenReceipt = await command(finance, "/api/v1/purchase-receipts", receiptPayload);
    assert.equal(forbiddenReceipt.status, 403);

    const [[receiptFacts]] = await db.query(
      "SELECT (SELECT received_quantity FROM order_items WHERE id = ?) AS receivedQuantity, (SELECT COUNT(*) FROM purchase_receipts WHERE order_item_id = ?) AS receiptRows, (SELECT COUNT(*) FROM inventory_batches WHERE id = ?) AS batchRows, (SELECT COUNT(*) FROM inventory_movements WHERE source_key = ? AND type = 'inbound') AS inboundRows",
      [fixture.orderItemId, fixture.orderItemId, receiptBatchId, "purchase_receipt:" + receiptId],
    );
    assert.equal(Number(receiptFacts.receivedQuantity), 10);
    assert.deepEqual([Number(receiptFacts.receiptRows), Number(receiptFacts.batchRows), Number(receiptFacts.inboundRows)], [1, 1, 1]);

    const passPayload = {
      batchId: receiptBatchId,
      stage: "incoming",
      inspectionMethod: "full",
      batchQuantity: 10,
      inspectedQuantity: 10,
      passedQuantity: 10,
      failedQuantity: 0,
      inspectorType: "company_qc",
    };
    const pass = await command(admin, "/api/v1/quality-inspections", passPayload);
    assert.equal(pass.status, 201, JSON.stringify(safeHttp("quality-pass", pass)));
    const [[passedBatch]] = await db.query(
      "SELECT pending_inspection_quantity AS pending, available_quantity AS available, quarantine_quantity AS quarantine FROM inventory_batches WHERE id = ?",
      [receiptBatchId],
    );
    assert.deepEqual([Number(passedBatch.pending), Number(passedBatch.available), Number(passedBatch.quarantine)], [0, 10, 0]);

    const duplicateInspection = await command(admin, "/api/v1/quality-inspections", passPayload);
    assert.equal(duplicateInspection.status, 409);

    const secondReceiptPayload = {
      purchaseOrderId: fixture.purchaseOrderId,
      orderItemId: secondOrderItemId,
      warehouseId: fixture.warehouseId,
      receivedQuantity: 4,
    };
    const secondReceipt = await command(session, "/api/v1/purchase-receipts", secondReceiptPayload);
    assert.equal(secondReceipt.status, 201, JSON.stringify(safeHttp("receipt-fail", secondReceipt)));
    const failBatchId = secondReceipt.body.result.receipt.batchId;
    const failPayload = {
      batchId: failBatchId,
      stage: "incoming",
      inspectionMethod: "full",
      batchQuantity: 4,
      inspectedQuantity: 4,
      passedQuantity: 0,
      failedQuantity: 4,
      defectReason: "E2E whole-batch defect",
      inspectorType: "company_qc",
    };
    const fail = await command(admin, "/api/v1/quality-inspections", failPayload);
    assert.equal(fail.status, 201, JSON.stringify(safeHttp("quality-fail", fail)));
    const [[failedBatch]] = await db.query(
      "SELECT pending_inspection_quantity AS pending, available_quantity AS available, quarantine_quantity AS quarantine FROM inventory_batches WHERE id = ?",
      [failBatchId],
    );
    assert.deepEqual([Number(failedBatch.pending), Number(failedBatch.available), Number(failedBatch.quarantine)], [0, 0, 4]);

    const reservePayload = {
      batchId: fixture.componentBatchId,
      entityType: "production_order",
      entityId: fixture.executionOrderId,
      requestedQuantity: 10,
      priority: 0,
    };
    const reserve = await command(session, "/api/v1/inventory", reservePayload);
    assert.equal(reserve.status, 201, JSON.stringify(safeHttp("reserve", reserve)));
    const [[reservedBatch]] = await db.query(
      "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
      [fixture.componentBatchId],
    );
    assert.deepEqual([Number(reservedBatch.available), Number(reservedBatch.locked)], [0, 10]);

    const [lines] = await db.query("SELECT id FROM production_material_lines WHERE execution_order_id = ? ORDER BY id", [fixture.executionOrderId]);
    const materialLineId = lines[0].id;
    const materialsPayload = {
      id: fixture.executionOrderId,
      action: "materials",
      materials: [{ id: materialLineId, issuedQuantity: 2, consumedQuantity: 1, lossQuantity: 0 }],
    };
    const materialsKey = runtime.runId + "-r3-materials-0001";
    const materials = await command(session, "/api/v1/production-orders", materialsPayload, { method: "PATCH", key: materialsKey });
    assert.equal(materials.status, 200, JSON.stringify(safeHttp("materials", materials)));
    const [[consumedBatch]] = await db.query(
      "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
      [fixture.componentBatchId],
    );
    assert.deepEqual([Number(consumedBatch.available), Number(consumedBatch.locked)], [0, 9]);
    const [[reservation]] = await db.query(
      "SELECT reserved_quantity AS reserved, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?",
      [fixture.executionOrderId],
    );
    assert.deepEqual([Number(reservation.reserved), reservation.status], [9, "active"]);

    const materialsReplay = await command(session, "/api/v1/production-orders", materialsPayload, { method: "PATCH", key: materialsKey });
    assert.equal(materialsReplay.status, 200);
    assert.equal(materialsReplay.body.command.replayed, true);

    const decreasePayload = {
      id: fixture.executionOrderId,
      action: "materials",
      materials: [{ id: materialLineId, issuedQuantity: 2, consumedQuantity: 0, lossQuantity: 0 }],
    };
    const decrease = await command(session, "/api/v1/production-orders", decreasePayload, { method: "PATCH" });
    assert.equal(decrease.status, 409);

    const releasePayload = { id: fixture.executionOrderId, action: "release_materials" };
    const releaseKey = runtime.runId + "-r3-release-0001";
    const release = await command(session, "/api/v1/production-orders", releasePayload, { method: "PATCH", key: releaseKey });
    assert.equal(release.status, 200, JSON.stringify(safeHttp("release", release)));
    const [[releasedBatch]] = await db.query(
      "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
      [fixture.componentBatchId],
    );
    assert.deepEqual([Number(releasedBatch.available), Number(releasedBatch.locked)], [9, 0]);
    const [[releasedReservation]] = await db.query(
      "SELECT reserved_quantity AS reserved, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?",
      [fixture.executionOrderId],
    );
    assert.deepEqual([Number(releasedReservation.reserved), releasedReservation.status], [0, "released"]);

    const releaseReplay = await command(session, "/api/v1/production-orders", releasePayload, { method: "PATCH", key: releaseKey });
    assert.equal(releaseReplay.status, 200);
    assert.equal(releaseReplay.body.command.replayed, true);

    const home = await requestJson(runtime.origins.https, "/", { method: "GET" });
    assert.equal(home.status, 200);

    const [[evidence]] = await db.query(
      "SELECT (SELECT COUNT(*) FROM audit_logs WHERE module IN ('purchase_receipts', 'quality', 'production', 'inventory')) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key LIKE 'r3:%') AS outboxRows",
    );
    assert.ok(Number(evidence.audits) >= 6);
    assert.ok(Number(evidence.outboxRows) >= 6);
  });
});
