import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { buildRuntimeApp } from "../dist/runtime.js";
import { createDatabaseClient } from "../dist/infrastructure/database.js";
import { canonicalRequestDigest } from "../dist/platform/commands.js";
import operationsManifest from "../dist/composition/operations-writes-manifest.js";

const databaseUrl = process.env.MYSQL_OPERATIONS_TEST_URL?.trim();

async function createActor(db, suffix, role, factoryId = null) {
  const user = await db.execute(
    "INSERT INTO users (email, mobile, name, role, factory_id, organization_name, account_status, created_at, updated_at) VALUES (?, '13800138000', ?, ?, ?, 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["r3-closure-" + role + "-" + suffix + "@example.com", "R3 " + role, role, factoryId],
  );
  const token = createHash("sha256").update("session:" + role + ":" + suffix).digest("hex");
  const session = await db.execute(
    "INSERT INTO auth_sessions (user_id, token_hash, device_id, expires_at, created_at, last_seen_at) VALUES (?, SHA2(?, 256), ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [user.insertId, token, "device-" + suffix, new Date(Date.now() + 3_600_000).toISOString()],
  );
  return { userId: user.insertId, sessionId: session.insertId, token };
}

function headers(actor, command, payload, key = randomUUID()) {
  const csrf = createHash("sha256").update("csrf:" + actor.token).digest("hex");
  return {
    host: "scm.topologygz.com",
    origin: "https://scm.topologygz.com",
    "x-forwarded-host": "scm.topologygz.com",
    "x-forwarded-proto": "https",
    cookie: "topology_session=" + actor.token + "; topology_csrf=" + csrf,
    "x-csrf-token": csrf,
    "idempotency-key": key,
    "x-request-digest": canonicalRequestDigest(command, payload),
    "content-type": "application/json",
  };
}

function readHeaders(actor) {
  const csrf = createHash("sha256").update("csrf:" + actor.token).digest("hex");
  return {
    host: "scm.topologygz.com",
    origin: "https://scm.topologygz.com",
    "x-forwarded-host": "scm.topologygz.com",
    "x-forwarded-proto": "https",
    cookie: "topology_session=" + actor.token + "; topology_csrf=" + csrf,
    "x-csrf-token": csrf,
  };
}

test("Scope A closures: purchase receipt -> pending batch -> quality pass/fail -> production reserve/consume/release", {
  skip: !databaseUrl && "set MYSQL_OPERATIONS_TEST_URL to run Scope A closures MySQL integration",
  timeout: 120_000,
}, async (t) => {
  const suffix = process.pid + "-" + Date.now();
  const db = createDatabaseClient({
    env: {
      DATABASE_URL: databaseUrl,
      DB_SSL: "disabled",
      DB_POOL_SIZE: "20",
      DB_QUERY_TIMEOUT_MS: "30000",
      DB_TRANSACTION_TIMEOUT_MS: "60000",
    },
  });
  t.after(() => db.close());

  await db.execute(
    "UPDATE writer_fences SET enabled = 1, owner = 'fastify-v1', generation = 2 WHERE resource IN ('r3.purchase-receipts.commands', 'r3.quality-inspections.commands', 'r3.inventory.commands', 'r3.production-orders.commands')",
  );

  const admin = await createActor(db, suffix, "admin");
  const finance = await createActor(db, suffix + "-finance", "finance");
  const app = await buildRuntimeApp({
    logger: false,
    database: db,
    registrationManifests: [operationsManifest],
    environment: { NODE_ENV: "test" },
  });
  t.after(() => app.close());

  const factory = await db.execute(
    "INSERT INTO factories (name, code, status, created_at, updated_at) VALUES ('R3 Closure Factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-F-" + suffix],
  );
  const warehouse = await db.execute(
    "INSERT INTO warehouses (code, name, type, factory_id, status, created_at, updated_at) VALUES (?, 'R3 Closure Warehouse', 'company', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-WH-" + suffix, factory.insertId],
  );

  const componentSku = "R3-COMP-" + suffix;
  await db.execute(
    "INSERT INTO skus (code, name, item_type, stock_unit, verification_status, status, created_at, updated_at) VALUES (?, 'R3 Component', 'component', 'EA', 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [componentSku],
  );
  await db.execute(
    "INSERT INTO quality_rules (scope, item_type, stage, minimum_pass_rate_bps, active, created_by, created_at, updated_at) VALUES ('item_type', 'component', 'incoming', 5000, 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [admin.userId],
  );
  const componentBom = await db.execute(
    "INSERT INTO product_boms (finished_sku, version, effective_from, approval_status, active, created_by, created_at, updated_at) VALUES (?, 'R3-CL-COMP-BOM-1', '2026-01-01', 'approved', 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [componentSku, admin.userId],
  );

  async function createComponentPurchase(quantity) {
    const po = await db.execute(
      "INSERT INTO purchase_orders (order_no, status, order_date, total_tax_included_minor, created_at, updated_at) VALUES (?, 'confirmed', '2026-08-01', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-PO-" + randomUUID(), quantity * 10],
    );
    const item = await db.execute(
      "INSERT INTO order_items (purchase_order_id, sku, product_name, item_type, quantity, received_quantity, unit_price_tax_included_minor, amount_tax_included_minor, due_date, created_at, updated_at) VALUES (?, ?, 'R3 Component', 'component', ?, 0, 10, ?, '2026-09-01', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [po.insertId, componentSku, quantity, quantity * 10],
    );
    const plan = await db.execute(
      "INSERT INTO purchase_plans (plan_no, status, created_by, created_at, updated_at) VALUES (?, 'approved', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-COMP-PLAN-" + randomUUID(), admin.userId],
    );
    const planItem = await db.execute(
      "INSERT INTO purchase_plan_items (purchase_plan_id, expected_arrival_date, factory_id, warehouse_id, sku, product_name, bom_id, planned_quantity, ordered_quantity, created_at, updated_at) VALUES (?, '2026-09-01', ?, ?, ?, 'R3 Component', ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [plan.insertId, factory.insertId, warehouse.insertId, componentSku, componentBom.insertId, quantity, quantity],
    );
    await db.execute(
      "INSERT INTO purchase_plan_order_links (purchase_plan_item_id, order_item_id, allocated_quantity, match_method, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, 'manual', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [planItem.insertId, item.insertId, quantity, admin.userId],
    );
    return { purchaseOrderId: po.insertId, orderItemId: item.insertId };
  }

  async function allocate(orderItemId, { factoryId, warehouseId, sku, bomId, quantity }) {
    const plan = await db.execute(
      "INSERT INTO purchase_plans (plan_no, status, created_by, created_at, updated_at) VALUES (?, 'approved', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-ALLOC-PLAN-" + randomUUID(), admin.userId],
    );
    const planItem = await db.execute(
      "INSERT INTO purchase_plan_items (purchase_plan_id, expected_arrival_date, factory_id, warehouse_id, sku, product_name, bom_id, planned_quantity, ordered_quantity, created_at, updated_at) VALUES (?, '2026-09-01', ?, ?, ?, 'R3 Allocation', ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [plan.insertId, factoryId, warehouseId, sku, bomId, quantity, quantity],
    );
    await db.execute(
      "INSERT INTO purchase_plan_order_links (purchase_plan_item_id, order_item_id, allocated_quantity, match_method, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, 'manual', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [planItem.insertId, orderItemId, quantity, admin.userId],
    );
    return planItem.insertId;
  }

  async function insertConfirmedComponentOrder(sku, quantity, status = "confirmed") {
    const po = await db.execute(
      "INSERT INTO purchase_orders (order_no, status, order_date, total_tax_included_minor, created_at, updated_at) VALUES (?, ?, '2026-08-01', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-NEG-PO-" + randomUUID(), status, quantity * 10],
    );
    const item = await db.execute(
      "INSERT INTO order_items (purchase_order_id, sku, product_name, item_type, quantity, received_quantity, unit_price_tax_included_minor, amount_tax_included_minor, due_date, created_at, updated_at) VALUES (?, ?, 'R3 Component', 'component', ?, 0, 10, ?, '2026-09-01', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [po.insertId, sku, quantity, quantity * 10],
    );
    return { purchaseOrderId: po.insertId, orderItemId: item.insertId };
  }

  async function createFinishedProductionOrder(plannedQuantity = 2) {
    const po = await db.execute(
      "INSERT INTO purchase_orders (order_no, status, order_date, total_tax_included_minor, created_at, updated_at) VALUES (?, 'confirmed', '2026-08-01', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-FG-PO-" + randomUUID(), plannedQuantity * 10],
    );
    const item = await db.execute(
      "INSERT INTO order_items (purchase_order_id, sku, product_name, item_type, quantity, received_quantity, unit_price_tax_included_minor, amount_tax_included_minor, due_date, created_at, updated_at) VALUES (?, ?, 'R3 Finished', 'finished', ?, 0, 10, ?, '2026-09-01', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      [po.insertId, finishedSku, plannedQuantity, plannedQuantity * 10],
    );
    await allocate(item.insertId, { factoryId: factory.insertId, warehouseId: warehouse.insertId, sku: finishedSku, bomId: bom.insertId, quantity: plannedQuantity });
    const create = { orderItemId: item.insertId, factoryId: factory.insertId, bomId: bom.insertId, plannedQuantity, plannedStartDate: "2026-08-15", plannedFinishDate: "2026-08-31" };
    const created = await app.inject({ method: "POST", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.create", create), payload: create });
    assert.equal(created.statusCode, 201, created.body);
    return { productionOrderId: created.json().result.order.id, orderItemId: item.insertId };
  }

  async function createComponentBatch(available) {
    const batch = await db.execute(
      "INSERT INTO inventory_batches (batch_no, warehouse_id, sku, inbound_date, available_quantity, locked_quantity, defective_quantity, pending_inspection_quantity, quarantine_quantity, ownership, expiry_status, created_at, updated_at) VALUES (?, ?, ?, CURRENT_DATE(), ?, 0, 0, 0, 0, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
      ["R3-CL-COMP-BATCH-" + randomUUID(), warehouse.insertId, componentSku, available],
    );
    return batch.insertId;
  }

  const componentA = await createComponentPurchase(5);
  const receivePayload = {
    purchaseOrderId: componentA.purchaseOrderId,
    orderItemId: componentA.orderItemId,
    warehouseId: warehouse.insertId,
    receivedQuantity: 5,
  };
  const receiveKey = suffix + "-purchase-receive";
  const receive = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", receivePayload, receiveKey),
    payload: receivePayload,
  });
  assert.equal(receive.statusCode, 201, receive.body);
  const receiptId = receive.json().result.receipt.id;

  const [receivedBatch] = await db.query(
    "SELECT id, batch_no AS batchNo, pending_inspection_quantity AS pending, available_quantity AS available, locked_quantity AS locked, quarantine_quantity AS quarantine FROM inventory_batches WHERE sku = ? AND warehouse_id = ?",
    [componentSku, warehouse.insertId],
  );
  assert.equal(Number(receivedBatch.pending), 5);
  assert.deepEqual([Number(receivedBatch.available), Number(receivedBatch.locked), Number(receivedBatch.quarantine)], [0, 0, 0]);

  const [receivedFacts] = await db.query(
    "SELECT (SELECT received_quantity FROM order_items WHERE id = ?) AS receivedQuantity, (SELECT COUNT(*) FROM purchase_receipts WHERE id = ?) AS receiptRows, (SELECT COUNT(*) FROM inventory_movements WHERE source_key = ? AND type = 'inbound') AS inboundRows, (SELECT COUNT(*) FROM audit_logs WHERE module = 'purchase_receipts' AND entity_type = 'purchase_receipt' AND entity_id = ?) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type = 'purchase_receipt' AND aggregate_id = ?) AS outboxRows",
    [componentA.orderItemId, receiptId, "purchase_receipt:" + receiptId, String(receiptId), String(receiptId)],
  );
  assert.equal(Number(receivedFacts.receivedQuantity), 5);
  assert.deepEqual([Number(receivedFacts.receiptRows), Number(receivedFacts.inboundRows), Number(receivedFacts.audits), Number(receivedFacts.outboxRows)], [1, 1, 1, 1]);

  const receiveReplay = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", receivePayload, receiveKey),
    payload: receivePayload,
  });
  assert.equal(receiveReplay.statusCode, 201);
  assert.equal(receiveReplay.json().command.replayed, true);
  const [receiptCountAfterReplay] = await db.query("SELECT COUNT(*) AS count FROM purchase_receipts WHERE order_item_id = ?", [componentA.orderItemId]);
  assert.equal(Number(receiptCountAfterReplay.count), 1);

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", receivePayload),
    payload: receivePayload,
  });
  assert.equal(duplicate.statusCode, 409);
  const componentPartial = await createComponentPurchase(4);
  const partialPayload = {
    purchaseOrderId: componentPartial.purchaseOrderId,
    orderItemId: componentPartial.orderItemId,
    warehouseId: warehouse.insertId,
    receivedQuantity: 2,
  };
  const partial = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", partialPayload),
    payload: partialPayload,
  });
  assert.equal(partial.statusCode, 400);
  const unauthorizedReceipt = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(finance, "purchase.receive", receivePayload),
    payload: receivePayload,
  });
  assert.equal(unauthorizedReceipt.statusCode, 403);

  const passPayload = {
    batchId: receivedBatch.id,
    stage: "incoming",
    inspectionMethod: "full",
    batchQuantity: 5,
    inspectedQuantity: 5,
    passedQuantity: 5,
    failedQuantity: 0,
    inspectorType: "company_qc",
  };
  const pass = await app.inject({
    method: "POST",
    url: "/api/v1/quality-inspections",
    headers: headers(admin, "quality.inspection.submit", passPayload),
    payload: passPayload,
  });
  assert.equal(pass.statusCode, 201, pass.body);
  const passInspectionId = pass.json().result.inspection.id;
  const [passedBatch] = await db.query(
    "SELECT pending_inspection_quantity AS pending, available_quantity AS available, quarantine_quantity AS quarantine FROM inventory_batches WHERE id = ?",
    [receivedBatch.id],
  );
  assert.deepEqual([Number(passedBatch.pending), Number(passedBatch.available), Number(passedBatch.quarantine)], [0, 5, 0]);
  const [passMovement] = await db.query(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE source_key = ? AND type = 'inspection_pass'",
    ["quality_inspection:" + passInspectionId + ":pass"],
  );
  assert.equal(Number(passMovement.count), 1);
  const [passInspection] = await db.query(
    "SELECT final_result AS finalResult, released_quantity AS releasedQuantity FROM quality_inspections WHERE id = ?",
    [passInspectionId],
  );
  assert.deepEqual([passInspection.finalResult, Number(passInspection.releasedQuantity)], ["passed", 5]);

  const duplicateInspection = await app.inject({
    method: "POST",
    url: "/api/v1/quality-inspections",
    headers: headers(admin, "quality.inspection.submit", passPayload),
    payload: passPayload,
  });
  assert.equal(duplicateInspection.statusCode, 409);

  const componentB = await createComponentPurchase(7);
  const receiveBPayload = {
    purchaseOrderId: componentB.purchaseOrderId,
    orderItemId: componentB.orderItemId,
    warehouseId: warehouse.insertId,
    receivedQuantity: 7,
  };
  const receiveB = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", receiveBPayload),
    payload: receiveBPayload,
  });
  assert.equal(receiveB.statusCode, 201, receiveB.body);
  const [failedSourceBatch] = await db.query(
    "SELECT id FROM inventory_batches WHERE sku = ? AND warehouse_id = ? AND pending_inspection_quantity = 7 ORDER BY id DESC LIMIT 1",
    [componentSku, warehouse.insertId],
  );
  const failPayload = {
    batchId: failedSourceBatch.id,
    stage: "incoming",
    inspectionMethod: "full",
    batchQuantity: 7,
    inspectedQuantity: 7,
    passedQuantity: 0,
    failedQuantity: 7,
    defectReason: "R3 whole-batch defect",
    inspectorType: "company_qc",
  };
  const fail = await app.inject({
    method: "POST",
    url: "/api/v1/quality-inspections",
    headers: headers(admin, "quality.inspection.submit", failPayload),
    payload: failPayload,
  });
  assert.equal(fail.statusCode, 201, fail.body);
  const failInspectionId = fail.json().result.inspection.id;
  const [failedBatch] = await db.query(
    "SELECT pending_inspection_quantity AS pending, available_quantity AS available, quarantine_quantity AS quarantine FROM inventory_batches WHERE id = ?",
    [failedSourceBatch.id],
  );
  assert.deepEqual([Number(failedBatch.pending), Number(failedBatch.available), Number(failedBatch.quarantine)], [0, 0, 7]);
  const [failMovement] = await db.query(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE source_key = ? AND type = 'inspection_fail'",
    ["quality_inspection:" + failInspectionId + ":fail"],
  );
  assert.equal(Number(failMovement.count), 1);

  const componentC = await createComponentPurchase(3);
  const receiveCPayload = {
    purchaseOrderId: componentC.purchaseOrderId,
    orderItemId: componentC.orderItemId,
    warehouseId: warehouse.insertId,
    receivedQuantity: 3,
  };
  const receiveC = await app.inject({
    method: "POST",
    url: "/api/v1/purchase-receipts",
    headers: headers(admin, "purchase.receive", receiveCPayload),
    payload: receiveCPayload,
  });
  assert.equal(receiveC.statusCode, 201, receiveC.body);
  const [mixedSourceBatch] = await db.query(
    "SELECT id FROM inventory_batches WHERE sku = ? AND warehouse_id = ? AND pending_inspection_quantity = 3 ORDER BY id DESC LIMIT 1",
    [componentSku, warehouse.insertId],
  );
  const mixedPayload = {
    batchId: mixedSourceBatch.id,
    stage: "incoming",
    inspectionMethod: "full",
    batchQuantity: 3,
    inspectedQuantity: 3,
    passedQuantity: 1,
    failedQuantity: 2,
    defectReason: "R3 mixed defect",
    inspectorType: "company_qc",
  };
  const mixed = await app.inject({
    method: "POST",
    url: "/api/v1/quality-inspections",
    headers: headers(admin, "quality.inspection.submit", mixedPayload),
    payload: mixedPayload,
  });
  assert.equal(mixed.statusCode, 400);
  const unauthorizedInspection = await app.inject({
    method: "POST",
    url: "/api/v1/quality-inspections",
    headers: headers(finance, "quality.inspection.submit", passPayload),
    payload: passPayload,
  });
  assert.equal(unauthorizedInspection.statusCode, 403);

  const finishedSku = "R3-FG-" + suffix;
  await db.execute(
    "INSERT INTO skus (code, name, item_type, stock_unit, verification_status, status, created_at, updated_at) VALUES (?, 'R3 Finished', 'finished', 'EA', 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [finishedSku],
  );
  const bom = await db.execute(
    "INSERT INTO product_boms (finished_sku, version, effective_from, approval_status, active, created_by, created_at, updated_at) VALUES (?, 'R3-CL-BOM-1', '2026-01-01', 'approved', 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [finishedSku, admin.userId],
  );
  await db.execute(
    "INSERT INTO bom_components (bom_id, component_sku, item_type, is_core, quantity_per_finished) VALUES (?, ?, 'component', 1, 1)",
    [bom.insertId, componentSku],
  );
  const plan = await db.execute(
    "INSERT INTO purchase_plans (plan_no, status, created_by, created_at, updated_at) VALUES (?, 'approved', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-PLAN-" + suffix, admin.userId],
  );
  const planItem = await db.execute(
    "INSERT INTO purchase_plan_items (purchase_plan_id, expected_arrival_date, factory_id, warehouse_id, sku, product_name, bom_id, planned_quantity, ordered_quantity, created_at, updated_at) VALUES (?, '2026-09-01', ?, ?, ?, 'R3 Finished', ?, 2, 2, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [plan.insertId, factory.insertId, warehouse.insertId, finishedSku, bom.insertId],
  );
  const productionPo = await db.execute(
    "INSERT INTO purchase_orders (order_no, status, order_date, total_tax_included_minor, created_at, updated_at) VALUES (?, 'active', '2026-08-01', 20, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-PROD-PO-" + suffix],
  );
  const productionItem = await db.execute(
    "INSERT INTO order_items (purchase_order_id, sku, product_name, item_type, quantity, received_quantity, unit_price_tax_included_minor, amount_tax_included_minor, due_date, created_at, updated_at) VALUES (?, ?, 'R3 Finished', 'finished', 2, 0, 10, 20, '2026-09-01', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [productionPo.insertId, finishedSku],
  );
  await db.execute(
    "INSERT INTO purchase_plan_order_links (purchase_plan_item_id, order_item_id, allocated_quantity, match_method, confirmed_by, created_at, updated_at) VALUES (?, ?, 2, 'manual', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [planItem.insertId, productionItem.insertId, admin.userId],
  );
  const productionCreate = {
    orderItemId: productionItem.insertId,
    factoryId: factory.insertId,
    bomId: bom.insertId,
    plannedQuantity: 2,
    plannedStartDate: "2026-08-15",
    plannedFinishDate: "2026-08-31",
  };
  const productionCreated = await app.inject({
    method: "POST",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.create", productionCreate),
    payload: productionCreate,
  });
  assert.equal(productionCreated.statusCode, 201, productionCreated.body);
  const productionOrderId = productionCreated.json().result.order.id;

  const componentBatch = await db.execute(
    "INSERT INTO inventory_batches (batch_no, warehouse_id, sku, inbound_date, available_quantity, locked_quantity, defective_quantity, pending_inspection_quantity, quarantine_quantity, ownership, expiry_status, created_at, updated_at) VALUES (?, ?, ?, CURRENT_DATE(), 2, 0, 0, 0, 0, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-COMP-BATCH-" + suffix, warehouse.insertId, componentSku],
  );
  const reservePayload = {
    batchId: componentBatch.insertId,
    entityType: "production_order",
    entityId: productionOrderId,
    requestedQuantity: 2,
    priority: 0,
  };
  const reserve = await app.inject({
    method: "POST",
    url: "/api/v1/inventory",
    headers: headers(admin, "inventory.reserve", reservePayload),
    payload: reservePayload,
  });
  assert.equal(reserve.statusCode, 201, reserve.body);
  const [reservedBatch] = await db.query(
    "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
    [componentBatch.insertId],
  );
  assert.deepEqual([Number(reservedBatch.available), Number(reservedBatch.locked)], [0, 2]);
  const [reservation] = await db.query(
    "SELECT reserved_quantity AS reserved, shortage_quantity AS shortage, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?",
    [productionOrderId],
  );
  assert.deepEqual([Number(reservation.reserved), Number(reservation.shortage), reservation.status], [2, 0, "active"]);

  const [materialLine] = await db.query(
    "SELECT id FROM production_material_lines WHERE execution_order_id = ? LIMIT 1",
    [productionOrderId],
  );
  const materialsPayload = {
    id: productionOrderId,
    action: "materials",
    materials: [{ id: materialLine.id, issuedQuantity: 2, consumedQuantity: 1, lossQuantity: 0 }],
  };
  const materialsKey = suffix + "-production-materials";
  const materials = await app.inject({
    method: "PATCH",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.transition", materialsPayload, materialsKey),
    payload: materialsPayload,
  });
  assert.equal(materials.statusCode, 200, materials.body);
  const [consumedBatch] = await db.query(
    "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
    [componentBatch.insertId],
  );
  assert.deepEqual([Number(consumedBatch.available), Number(consumedBatch.locked)], [0, 1]);
  const [consumedReservation] = await db.query(
    "SELECT reserved_quantity AS reserved, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?",
    [productionOrderId],
  );
  assert.deepEqual([Number(consumedReservation.reserved), consumedReservation.status], [1, "active"]);
  const [consumedLine] = await db.query(
    "SELECT issued_quantity AS issued, consumed_quantity AS consumed, loss_quantity AS loss FROM production_material_lines WHERE id = ?",
    [materialLine.id],
  );
  assert.deepEqual([Number(consumedLine.issued), Number(consumedLine.consumed), Number(consumedLine.loss)], [2, 1, 0]);

  const materialsReplay = await app.inject({
    method: "PATCH",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.transition", materialsPayload, materialsKey),
    payload: materialsPayload,
  });
  assert.equal(materialsReplay.statusCode, 200);
  assert.equal(materialsReplay.json().command.replayed, true);
  const [consumedBatchAfterReplay] = await db.query(
    "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
    [componentBatch.insertId],
  );
  assert.deepEqual([Number(consumedBatchAfterReplay.available), Number(consumedBatchAfterReplay.locked)], [0, 1]);

  const decreasePayload = {
    id: productionOrderId,
    action: "materials",
    materials: [{ id: materialLine.id, issuedQuantity: 2, consumedQuantity: 0, lossQuantity: 0 }],
  };
  const decrease = await app.inject({
    method: "PATCH",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.transition", decreasePayload),
    payload: decreasePayload,
  });
  assert.equal(decrease.statusCode, 409);
  const [lineAfterDecrease] = await db.query(
    "SELECT issued_quantity AS issued, consumed_quantity AS consumed, loss_quantity AS loss FROM production_material_lines WHERE id = ?",
    [materialLine.id],
  );
  assert.deepEqual([Number(lineAfterDecrease.issued), Number(lineAfterDecrease.consumed), Number(lineAfterDecrease.loss)], [2, 1, 0]);

  const releasePayload = { id: productionOrderId, action: "release_materials" };
  const releaseKey = suffix + "-production-release";
  const release = await app.inject({
    method: "PATCH",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.transition", releasePayload, releaseKey),
    payload: releasePayload,
  });
  assert.equal(release.statusCode, 200, release.body);
  const [releasedBatch] = await db.query(
    "SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?",
    [componentBatch.insertId],
  );
  assert.deepEqual([Number(releasedBatch.available), Number(releasedBatch.locked)], [1, 0]);
  const [releasedReservation] = await db.query(
    "SELECT reserved_quantity AS reserved, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?",
    [productionOrderId],
  );
  assert.deepEqual([Number(releasedReservation.reserved), releasedReservation.status], [0, "released"]);

  const releaseReplay = await app.inject({
    method: "PATCH",
    url: "/api/v1/production-orders",
    headers: headers(admin, "manufacturing.order.transition", releasePayload, releaseKey),
    payload: releasePayload,
  });
  assert.equal(releaseReplay.statusCode, 200);
  assert.equal(releaseReplay.json().command.replayed, true);
  const [releaseMovementCount] = await db.query(
    "SELECT COUNT(*) AS count FROM inventory_movements WHERE type = 'production_release' AND sku = ?",
    [componentSku],
  );
  assert.equal(Number(releaseMovementCount.count), 1);

  const [evidence] = await db.query(
    "SELECT (SELECT COUNT(*) FROM audit_logs WHERE module = 'purchase_receipts' AND actor_user_id = ?) AS receiptAudits, (SELECT COUNT(*) FROM audit_logs WHERE module = 'quality' AND actor_user_id = ?) AS qualityAudits, (SELECT COUNT(*) FROM audit_logs WHERE module = 'production' AND actor_user_id = ?) AS productionAudits, (SELECT COUNT(*) FROM audit_logs WHERE module = 'inventory' AND actor_user_id = ?) AS inventoryAudits, (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key LIKE 'r3:PurchaseOrderItemReceived:purchase_receipt:%') AS receiptOutbox, (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key LIKE 'r3:InspectionCompleted:quality_inspection:%' OR deduplication_key LIKE 'r3:DispositionRequired:quality_inspection:%') AS qualityOutbox, (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key LIKE 'r3:ProductionMaterialsReported:execution_order:%' OR deduplication_key LIKE 'r3:ProductionReservationReleased:execution_order:%') AS productionOutbox",
    [admin.userId, admin.userId, admin.userId, admin.userId],
  );
  assert.ok(Number(evidence.receiptAudits) >= 1);
  assert.ok(Number(evidence.qualityAudits) >= 2);
  assert.ok(Number(evidence.productionAudits) >= 2);
  assert.ok(Number(evidence.inventoryAudits) >= 1);
  assert.ok(Number(evidence.receiptOutbox) >= 1);
  assert.ok(Number(evidence.qualityOutbox) >= 2);
  assert.ok(Number(evidence.productionOutbox) >= 2);

  const companyQc = await createActor(db, suffix + "-companyqc", "company_qc");
  const factoryActor = await createActor(db, suffix + "-factoryactor", "factory", factory.insertId);
  const supplierQc = await createActor(db, suffix + "-supplierqc", "supplier_qc");
  const otherFactoryInsert = await db.execute(
    "INSERT INTO factories (name, code, status, created_at, updated_at) VALUES ('R3 Other Factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-OTHER-F-" + suffix],
  );
  const otherFactoryId = otherFactoryInsert.insertId;
  const otherWarehouseInsert = await db.execute(
    "INSERT INTO warehouses (code, name, type, factory_id, status, created_at, updated_at) VALUES (?, 'R3 Other Warehouse', 'company', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-OTHER-WH-" + suffix, factory.insertId],
  );
  const otherWarehouseId = otherWarehouseInsert.insertId;
  const otherFactoryWarehouseInsert = await db.execute(
    "INSERT INTO warehouses (code, name, type, factory_id, status, created_at, updated_at) VALUES (?, 'R3 Other Factory Warehouse', 'company', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    ["R3-CL-OTHER-F-WH-" + suffix, otherFactoryId],
  );
  const otherFactoryWarehouseId = otherFactoryWarehouseInsert.insertId;
  await db.execute(
    "INSERT INTO quality_rules (scope, item_type, stage, minimum_pass_rate_bps, active, created_by, created_at, updated_at) VALUES ('item_type', 'finished', 'finished_goods', 5000, 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))",
    [admin.userId],
  );


  await t.test("purchase receipt authority negatives", async () => {
    const draft = await insertConfirmedComponentOrder(componentSku, 2, "draft");
    await allocate(draft.orderItemId, { factoryId: factory.insertId, warehouseId: warehouse.insertId, sku: componentSku, bomId: componentBom.insertId, quantity: 2 });
    const draftRes = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", { purchaseOrderId: draft.purchaseOrderId, orderItemId: draft.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 }), payload: { purchaseOrderId: draft.purchaseOrderId, orderItemId: draft.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 } });
    assert.equal(draftRes.statusCode, 409, draftRes.body);

    const noAlloc = await insertConfirmedComponentOrder(componentSku, 2);
    const noAllocRes = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", { purchaseOrderId: noAlloc.purchaseOrderId, orderItemId: noAlloc.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 }), payload: { purchaseOrderId: noAlloc.purchaseOrderId, orderItemId: noAlloc.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 } });
    assert.equal(noAllocRes.statusCode, 409, noAllocRes.body);

    const wrongWarehouse = await insertConfirmedComponentOrder(componentSku, 2);
    await allocate(wrongWarehouse.orderItemId, { factoryId: factory.insertId, warehouseId: otherWarehouseId, sku: componentSku, bomId: componentBom.insertId, quantity: 2 });
    const wrongWarehouseRes = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", { purchaseOrderId: wrongWarehouse.purchaseOrderId, orderItemId: wrongWarehouse.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 }), payload: { purchaseOrderId: wrongWarehouse.purchaseOrderId, orderItemId: wrongWarehouse.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 } });
    assert.equal(wrongWarehouseRes.statusCode, 409, wrongWarehouseRes.body);

    const crossFactory = await insertConfirmedComponentOrder(componentSku, 2);
    await allocate(crossFactory.orderItemId, { factoryId: otherFactoryId, warehouseId: otherFactoryWarehouseId, sku: componentSku, bomId: componentBom.insertId, quantity: 2 });
    const crossFactoryPayload = { purchaseOrderId: crossFactory.purchaseOrderId, orderItemId: crossFactory.orderItemId, warehouseId: otherFactoryWarehouseId, receivedQuantity: 2 };
    const crossFactoryRes = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(factoryActor, "purchase.receive", crossFactoryPayload), payload: crossFactoryPayload });
    assert.equal(crossFactoryRes.statusCode, 403, crossFactoryRes.body);

    const multi = await insertConfirmedComponentOrder(componentSku, 2);
    await allocate(multi.orderItemId, { factoryId: factory.insertId, warehouseId: warehouse.insertId, sku: componentSku, bomId: componentBom.insertId, quantity: 1 });
    await allocate(multi.orderItemId, { factoryId: factory.insertId, warehouseId: otherWarehouseId, sku: componentSku, bomId: componentBom.insertId, quantity: 1 });
    const multiRes = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", { purchaseOrderId: multi.purchaseOrderId, orderItemId: multi.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 }), payload: { purchaseOrderId: multi.purchaseOrderId, orderItemId: multi.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 } });
    assert.equal(multiRes.statusCode, 409, multiRes.body);

    const concurrent = await createComponentPurchase(3);
    const concurrentPayload = { purchaseOrderId: concurrent.purchaseOrderId, orderItemId: concurrent.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 3 };
    const [concurrentA, concurrentB] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", concurrentPayload), payload: concurrentPayload }),
      app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", concurrentPayload), payload: concurrentPayload }),
    ]);
    assert.deepEqual([concurrentA.statusCode, concurrentB.statusCode].sort(), [201, 409]);
  });

  await t.test("production materials require real reservation backing", async () => {
    const order = await createFinishedProductionOrder(2);
    const [line] = await db.query("SELECT id FROM production_material_lines WHERE execution_order_id = ? LIMIT 1", [order.productionOrderId]);
    const noReservationPayload = { id: order.productionOrderId, action: "materials", materials: [{ id: line.id, issuedQuantity: 1, consumedQuantity: 0, lossQuantity: 0 }] };
    const noReservation = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", noReservationPayload), payload: noReservationPayload });
    assert.equal(noReservation.statusCode, 409, noReservation.body);

    const batchId = await createComponentBatch(1);
    const reservePayload = { batchId, entityType: "production_order", entityId: order.productionOrderId, requestedQuantity: 1, priority: 0 };
    const reserve = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: headers(admin, "inventory.reserve", reservePayload), payload: reservePayload });
    assert.equal(reserve.statusCode, 201, reserve.body);

    const insufficientPayload = { id: order.productionOrderId, action: "materials", materials: [{ id: line.id, issuedQuantity: 2, consumedQuantity: 0, lossQuantity: 0 }] };
    const insufficient = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", insufficientPayload), payload: insufficientPayload });
    assert.equal(insufficient.statusCode, 409, insufficient.body);
    const [afterInsufficient] = await db.query("SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?", [batchId]);
    assert.deepEqual([Number(afterInsufficient.available), Number(afterInsufficient.locked)], [0, 1]);
  });

  await t.test("active stocktake freezes consumption and release", async () => {
    const order = await createFinishedProductionOrder(2);
    const batchId = await createComponentBatch(2);
    const reservePayload = { batchId, entityType: "production_order", entityId: order.productionOrderId, requestedQuantity: 2, priority: 0 };
    const reserve = await app.inject({ method: "POST", url: "/api/v1/inventory", headers: headers(admin, "inventory.reserve", reservePayload), payload: reservePayload });
    assert.equal(reserve.statusCode, 201, reserve.body);

    await db.execute("INSERT INTO stocktakes (stocktake_no, warehouse_id, scope, due_date, status, created_by, assigned_factory_id, created_at, updated_at) VALUES (?, ?, 'full_warehouse', '2026-09-30', 'first_count', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))", ["R3-CL-FREEZE-" + suffix, warehouse.insertId, admin.userId, factory.insertId]);

    const [line] = await db.query("SELECT id FROM production_material_lines WHERE execution_order_id = ? LIMIT 1", [order.productionOrderId]);
    const consumePayload = { id: order.productionOrderId, action: "materials", materials: [{ id: line.id, issuedQuantity: 2, consumedQuantity: 1, lossQuantity: 0 }] };
    const consume = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", consumePayload), payload: consumePayload });
    assert.equal(consume.statusCode, 409, consume.body);

    const releasePayload = { id: order.productionOrderId, action: "release_materials" };
    const release = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", releasePayload), payload: releasePayload });
    assert.equal(release.statusCode, 409, release.body);

    const [frozen] = await db.query("SELECT available_quantity AS available, locked_quantity AS locked FROM inventory_batches WHERE id = ?", [batchId]);
    assert.deepEqual([Number(frozen.available), Number(frozen.locked)], [0, 2]);
    const [frozenReservation] = await db.query("SELECT reserved_quantity AS reserved, status FROM inventory_reservations WHERE entity_type = 'production_order' AND entity_id = ?", [order.productionOrderId]);
    assert.deepEqual([Number(frozenReservation.reserved), frozenReservation.status], [2, "active"]);

    await db.execute("UPDATE stocktakes SET status = 'completed', updated_at = CURRENT_TIMESTAMP(3) WHERE stocktake_no = ?", ["R3-CL-FREEZE-" + suffix]);
  });


  await t.test("company_qc pending-batches projection and submit", async () => {
    const purchase = await createComponentPurchase(3);
    const receivePayload = { purchaseOrderId: purchase.purchaseOrderId, orderItemId: purchase.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 3 };
    const receive = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", receivePayload), payload: receivePayload });
    assert.equal(receive.statusCode, 201, receive.body);
    const batchId = receive.json().result.receipt.batchId;

    const pending = await app.inject({ method: "GET", url: "/api/v1/quality-inspections/pending-batches", headers: readHeaders(companyQc) });
    assert.equal(pending.statusCode, 200, pending.body);
    const matches = pending.json().pendingBatches.filter((row) => row.batchId === batchId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].source, "receipt");
    assert.equal(matches[0].stage, "incoming");

    const submitPayload = { batchId, stage: "incoming", inspectionMethod: "full", batchQuantity: 3, inspectedQuantity: 3, passedQuantity: 3, failedQuantity: 0, inspectorType: "company_qc" };
    const submit = await app.inject({ method: "POST", url: "/api/v1/quality-inspections", headers: headers(companyQc, "quality.inspection.submit", submitPayload), payload: submitPayload });
    assert.equal(submit.statusCode, 201, submit.body);

    const factoryPending = await app.inject({ method: "GET", url: "/api/v1/quality-inspections/pending-batches", headers: readHeaders(factoryActor) });
    assert.equal(factoryPending.statusCode, 403, factoryPending.body);
    const supplierPending = await app.inject({ method: "GET", url: "/api/v1/quality-inspections/pending-batches", headers: readHeaders(supplierQc) });
    assert.equal(supplierPending.statusCode, 403, supplierPending.body);
  });

  await t.test("quality inspection provenance and stage closure", async () => {
    const purchase = await createComponentPurchase(2);
    const receivePayload = { purchaseOrderId: purchase.purchaseOrderId, orderItemId: purchase.orderItemId, warehouseId: warehouse.insertId, receivedQuantity: 2 };
    const receive = await app.inject({ method: "POST", url: "/api/v1/purchase-receipts", headers: headers(admin, "purchase.receive", receivePayload), payload: receivePayload });
    assert.equal(receive.statusCode, 201, receive.body);
    const receiptBatchId = receive.json().result.receipt.batchId;

    const wrongPurchaseStage = { batchId: receiptBatchId, stage: "finished_goods", inspectionMethod: "full", batchQuantity: 2, inspectedQuantity: 2, passedQuantity: 2, failedQuantity: 0, inspectorType: "company_qc" };
    const wrongPurchaseRes = await app.inject({ method: "POST", url: "/api/v1/quality-inspections", headers: headers(admin, "quality.inspection.submit", wrongPurchaseStage), payload: wrongPurchaseStage });
    assert.equal(wrongPurchaseRes.statusCode, 409, wrongPurchaseRes.body);

    const order = await createFinishedProductionOrder(2);
    const completePayload = { id: order.productionOrderId, action: "complete", actualFinishedQuantity: 2 };
    const complete = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", completePayload), payload: completePayload });
    assert.equal(complete.statusCode, 200, complete.body);
    const [prodBatch] = await db.query("SELECT id FROM inventory_batches WHERE sku = ? AND pending_inspection_quantity = 2 ORDER BY id DESC LIMIT 1", [finishedSku]);
    assert.ok(prodBatch, "expected a production completion batch");

    const wrongProductionStage = { batchId: prodBatch.id, stage: "incoming", inspectionMethod: "full", batchQuantity: 2, inspectedQuantity: 2, passedQuantity: 2, failedQuantity: 0, inspectorType: "company_qc" };
    const wrongProductionRes = await app.inject({ method: "POST", url: "/api/v1/quality-inspections", headers: headers(admin, "quality.inspection.submit", wrongProductionStage), payload: wrongProductionStage });
    assert.equal(wrongProductionRes.statusCode, 409, wrongProductionRes.body);

    const productionInspect = { batchId: prodBatch.id, stage: "finished_goods", inspectionMethod: "full", batchQuantity: 2, inspectedQuantity: 2, passedQuantity: 2, failedQuantity: 0, inspectorType: "company_qc" };
    const productionInspectRes = await app.inject({ method: "POST", url: "/api/v1/quality-inspections", headers: headers(admin, "quality.inspection.submit", productionInspect), payload: productionInspect });
    assert.equal(productionInspectRes.statusCode, 201, productionInspectRes.body);

    const unknown = await db.execute("INSERT INTO inventory_batches (batch_no, warehouse_id, sku, inbound_date, pending_inspection_quantity, available_quantity, locked_quantity, defective_quantity, quarantine_quantity, ownership, expiry_status, created_at, updated_at) VALUES (?, ?, ?, CURRENT_DATE(), 1, 0, 0, 0, 0, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))", ["R3-CL-UNKNOWN-" + suffix, warehouse.insertId, componentSku]);
    const unknownPayload = { batchId: unknown.insertId, stage: "incoming", inspectionMethod: "full", batchQuantity: 1, inspectedQuantity: 1, passedQuantity: 1, failedQuantity: 0, inspectorType: "company_qc" };
    const unknownRes = await app.inject({ method: "POST", url: "/api/v1/quality-inspections", headers: headers(admin, "quality.inspection.submit", unknownPayload), payload: unknownPayload });
    assert.equal(unknownRes.statusCode, 409, unknownRes.body);
  });

  await t.test("duplicate and illegal release are stable and non-mutating", async () => {
    const differentKeyPayload = { id: productionOrderId, action: "release_materials" };
    const differentKeyRes = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", differentKeyPayload), payload: differentKeyPayload });
    assert.equal(differentKeyRes.statusCode, 409, differentKeyRes.body);

    const completePayload = { id: productionOrderId, action: "complete", actualFinishedQuantity: 2 };
    const complete = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", completePayload), payload: completePayload });
    assert.equal(complete.statusCode, 200, complete.body);

    const beforeSql = "SELECT (SELECT COUNT(*) FROM audit_logs WHERE module = 'production' AND entity_type = 'execution_order' AND entity_id = ?) AS audits, (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_type = 'execution_order' AND aggregate_id = ?) AS outbox, (SELECT version FROM resource_versions WHERE resource_type = 'execution_order' AND resource_id = ?) AS version";
    const [before] = await db.query(beforeSql, [productionOrderId, productionOrderId, String(productionOrderId)]);

    const illegalReleasePayload = { id: productionOrderId, action: "release_materials" };
    const illegalRes = await app.inject({ method: "PATCH", url: "/api/v1/production-orders", headers: headers(admin, "manufacturing.order.transition", illegalReleasePayload), payload: illegalReleasePayload });
    assert.equal(illegalRes.statusCode, 409, illegalRes.body);

    const [after] = await db.query(beforeSql, [productionOrderId, productionOrderId, String(productionOrderId)]);
    assert.deepEqual([Number(after.audits), Number(after.outbox), Number(after.version)], [Number(before.audits), Number(before.outbox), Number(before.version)]);
  });

});
