import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { buildRuntimeApp } from "../dist/runtime.js";
import { createDatabaseClient } from "../dist/infrastructure/database.js";
import { canonicalRequestDigest } from "../dist/platform/commands.js";
import r3Manifest from "../dist/r3/manifest.js";

const databaseUrl = process.env.MYSQL_R3_TEST_URL?.trim();

const r2ProbeManifest = {
  id: "r2.approval-probe",
  register(context) {
    context.approvalEffects.register({
      effectType: "r2.probe_workflow",
      async execute({ transaction, claim }) {
        assert.equal(claim.objectType, "r2:approval_request");
        assert.equal(claim.action, "approve");
        const updated = await transaction.execute(
          `UPDATE resource_versions SET version = version + 1, updated_at = CURRENT_TIMESTAMP(3)
           WHERE resource_type = 'approval_request' AND resource_id = ? AND version = ?`,
          [claim.objectId, claim.objectVersion],
        );
        if (updated.affectedRows !== 1) throw new Error("R2 probe version CAS failed");
        return { owner:"r2", version:claim.objectVersion + 1 };
      },
    });
  },
};

function canonical(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function payloadDigest(payload) {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

async function createActor(db, suffix, role) {
  const user = await db.execute(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status, created_at, updated_at
     ) VALUES (?, '13800138000', ?, ?, 'Topology', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`r3-${role}-${suffix}@example.com`, `R3 ${role}`, role],
  );
  const token = createHash("sha256").update(`session:${role}:${suffix}`).digest("hex");
  const session = await db.execute(
    `INSERT INTO auth_sessions (
       user_id, token_hash, device_id, expires_at, created_at, last_seen_at
     ) VALUES (?, SHA2(?, 256), ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [user.insertId, token, `device-${suffix}`, new Date(Date.now() + 3_600_000).toISOString()],
  );
  return { userId: user.insertId, sessionId: session.insertId, token };
}

function headers(actor, command, payload, key = randomUUID()) {
  const csrf = createHash("sha256").update(`csrf:${actor.token}`).digest("hex");
  return {
    host: "scm.topologygz.com",
    origin: "https://scm.topologygz.com",
    "x-forwarded-host": "scm.topologygz.com",
    "x-forwarded-proto": "https",
    cookie: `topology_session=${actor.token}; topology_csrf=${csrf}`,
    "x-csrf-token": csrf,
    "idempotency-key": key,
    "x-request-digest": canonicalRequestDigest(command, payload),
    "content-type": "application/json",
  };
}

async function challenge(db, actor, input) {
  const challengeNo = `r3-${randomUUID()}`;
  await db.execute(
    `INSERT INTO auth_challenges (
       challenge_no, user_id, purpose, code_hash, device_id, expires_at,
       attempts, verified_at, session_id, action, object_type, object_id,
       object_version, request_digest, created_at, updated_at
     ) VALUES (?, ?, 'high_risk', 'verified', 'integration', ?, 0, CURRENT_TIMESTAMP(3),
               ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [challengeNo, actor.userId, new Date(Date.now() + 600_000).toISOString(), actor.sessionId,
     input.action, input.objectType, String(input.objectId), input.objectVersion, input.requestDigest],
  );
  return challengeNo;
}

test("R3 MySQL commands preserve inventory, finance, approval, audit, outbox and replay invariants", {
  skip: !databaseUrl && "set MYSQL_R3_TEST_URL to run R3 MySQL integration",
  timeout: 90_000,
}, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
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
    `UPDATE writer_fences SET enabled = 1, owner = 'fastify-v1', generation = 2
     WHERE resource LIKE 'r3.%'`,
  );
  const admin = await createActor(db, suffix, "admin");
  const financeOnly = await createActor(db, `${suffix}-finance`, "finance");
  const app = await buildRuntimeApp({
    logger: false,
    database: db,
    registrationManifests: [r2ProbeManifest, r3Manifest],
    environment: { NODE_ENV: "test" },
  });
  t.after(() => app.close());

  const warehouse = await db.execute(
    `INSERT INTO warehouses (code, name, type, status, created_at, updated_at)
     VALUES (?, 'R3 Warehouse', 'company', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-WH-${suffix}`],
  );
  const batch = await db.execute(
    `INSERT INTO inventory_batches (
       batch_no, warehouse_id, sku, inbound_date, available_quantity,
       ownership, expiry_status, created_at, updated_at
     ) VALUES (?, ?, 'R3-SKU', CURRENT_DATE(), 10, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-BATCH-${suffix}`, warehouse.insertId],
  );
  const inventoryPayload = () => ({
    batchId: batch.insertId,
    entityType: "historical",
    requestedQuantity: 7,
    priority: 0,
  });
  const inventoryRequests = [1, 2].map(() => {
    const payload = inventoryPayload();
    return app.inject({
      method: "POST",
      url: "/api/v1/inventory",
      headers: headers(admin, "inventory.reserve", payload),
      payload,
    });
  });
  const inventoryResponses = await Promise.all(inventoryRequests);
  assert.deepEqual(inventoryResponses.map((response) => response.statusCode), [201, 201]);
  const [inventory] = await db.query(
    `SELECT available_quantity AS availableQuantity, locked_quantity AS lockedQuantity
     FROM inventory_batches WHERE id = ?`, [batch.insertId],
  );
  const [reserved] = await db.query(
    `SELECT SUM(reserved_quantity) AS reservedQuantity, SUM(shortage_quantity) AS shortageQuantity
     FROM inventory_reservations WHERE batch_id = ?`, [batch.insertId],
  );
  assert.deepEqual([inventory.availableQuantity, inventory.lockedQuantity, Number(reserved.reservedQuantity), Number(reserved.shortageQuantity)], [0, 10, 10, 4]);

  const replayPayload = { batchId: batch.insertId, entityType: "historical", requestedQuantity: 1, priority: 0 };
  const replayKey = randomUUID();
  const replayResponses = [];
  for (let index = 0; index < 2; index += 1) {
    replayResponses.push(await app.inject({
      method: "POST", url: "/api/v1/inventory",
      headers: headers(admin, "inventory.reserve", replayPayload, replayKey), payload: replayPayload,
    }));
  }
  assert.equal(replayResponses[0].statusCode, 201);
  assert.equal(replayResponses[1].statusCode, 201);
  assert.equal(replayResponses[1].json().command.replayed, true);

  const freezeWarehouse = await db.execute(
    `INSERT INTO warehouses (code, name, type, status, created_at, updated_at)
     VALUES (?, 'R3 Freeze Warehouse', 'company', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-WH-FREEZE-${suffix}`],
  );
  const freezeBatch = await db.execute(
    `INSERT INTO inventory_batches (
       batch_no, warehouse_id, sku, inbound_date, available_quantity,
       ownership, expiry_status, created_at, updated_at
     ) VALUES (?, ?, 'R3-FREEZE-SKU', CURRENT_DATE(), 10, 'company', 'normal', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-FREEZE-BATCH-${suffix}`, freezeWarehouse.insertId],
  );
  const freezeOpen = { warehouseId:freezeWarehouse.insertId, scope:"full_warehouse", dueDate:"2099-12-31" };
  const freezeReserve = { batchId:freezeBatch.insertId, entityType:"historical", requestedQuantity:6, priority:0 };
  const [openResponse, reserveResponse] = await Promise.all([
    app.inject({ method:"POST", url:"/api/v1/stocktakes",
      headers:headers(admin, "inventory.stocktake.open", freezeOpen), payload:freezeOpen }),
    app.inject({ method:"POST", url:"/api/v1/inventory",
      headers:headers(admin, "inventory.reserve", freezeReserve), payload:freezeReserve }),
  ]);
  assert.equal(openResponse.statusCode, 201, openResponse.body);
  assert.ok([201, 409].includes(reserveResponse.statusCode), reserveResponse.body);
  const [freezeProjection] = await db.query(
    `SELECT b.available_quantity AS availableQuantity, b.locked_quantity AS lockedQuantity,
            c.available_quantity AS snapshotAvailable, c.locked_quantity AS snapshotLocked
     FROM inventory_batches b JOIN stocktake_counts c ON c.batch_id = b.id AND c.count_round = 0
     WHERE b.id = ?`, [freezeBatch.insertId],
  );
  assert.deepEqual(
    [freezeProjection.snapshotAvailable, freezeProjection.snapshotLocked],
    [freezeProjection.availableQuantity, freezeProjection.lockedQuantity],
    "stocktake snapshot must serialize with the inventory writer",
  );
  const newSkuTransfer = await db.execute(
    `INSERT INTO inventory_transfers (
       transfer_no, from_warehouse_id, to_warehouse_id, sku, quantity, reason,
       status, requested_by, shipped_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'R3-NEW-SKU-X', 3, 'full warehouse freeze oracle',
               'shipped', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-FREEZE-TR-${suffix}`, warehouse.insertId, freezeWarehouse.insertId, admin.userId],
  );
  const receiveNewSku = { id:newSkuTransfer.insertId, action:"receive" };
  const receiveNewSkuResponse = await app.inject({ method:"PATCH", url:"/api/v1/inventory/transfers",
    headers:headers(admin, "inventory.transfer.transition", receiveNewSku), payload:receiveNewSku });
  assert.equal(receiveNewSkuResponse.statusCode, 409, receiveNewSkuResponse.body);
  const [newSkuFacts] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM inventory_batches WHERE warehouse_id = ? AND sku = 'R3-NEW-SKU-X') AS batches,
       (SELECT COUNT(*) FROM inventory_movements WHERE warehouse_id = ? AND sku = 'R3-NEW-SKU-X') AS movements`,
    [freezeWarehouse.insertId, freezeWarehouse.insertId],
  );
  assert.deepEqual([Number(newSkuFacts.batches), Number(newSkuFacts.movements)], [0, 0]);

  const factory = await db.execute(
    `INSERT INTO factories (name, code, status, created_at, updated_at)
     VALUES ('R3 Factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`, [`R3-F-${suffix}`],
  );
  const factoryActor = await createActor(db, `${suffix}-factory`, "factory");
  await db.execute(`UPDATE users SET factory_id = ? WHERE id = ?`, [factory.insertId, factoryActor.userId]);
  const otherWarehouse = await db.execute(
    `INSERT INTO warehouses (code, name, type, status, created_at, updated_at)
     VALUES (?, 'R3 Other Warehouse', 'company', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-WH-OTHER-${suffix}`],
  );
  const productionBom = await db.execute(
    `INSERT INTO product_boms (
       finished_sku, version, effective_from, approval_status, active, created_by, created_at, updated_at
     ) VALUES ('R3-PROD-SKU', ?, '2026-01-01', 'approved', 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-V-${suffix}`, admin.userId],
  );
  const productionPlan = await db.execute(
    `INSERT INTO purchase_plans (plan_no, status, created_by, created_at, updated_at)
     VALUES (?, 'approved', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-PLAN-${suffix}`, admin.userId],
  );
  const productionPo = await db.execute(
    `INSERT INTO purchase_orders (order_no, status, order_date, total_tax_included_minor, created_at, updated_at)
     VALUES (?, 'active', '2026-08-01', 500, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-PROD-PO-${suffix}`],
  );
  const productionItem = await db.execute(
    `INSERT INTO order_items (
       purchase_order_id, sku, product_name, item_type, quantity,
       unit_price_tax_included_minor, amount_tax_included_minor, due_date, created_at, updated_at
     ) VALUES (?, 'R3-PROD-SKU', 'R3 Product', 'finished', 5, 100, 500, '2026-09-01', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [productionPo.insertId],
  );
  const planItem = await db.execute(
    `INSERT INTO purchase_plan_items (
       purchase_plan_id, expected_arrival_date, factory_id, warehouse_id, sku,
       product_name, bom_id, planned_quantity, ordered_quantity, created_at, updated_at
     ) VALUES (?, '2026-09-01', ?, ?, 'R3-PROD-SKU', 'R3 Product', ?, 5, 5, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [productionPlan.insertId, factory.insertId, warehouse.insertId, productionBom.insertId],
  );
  await db.execute(
    `INSERT INTO purchase_plan_order_links (
       purchase_plan_item_id, order_item_id, allocated_quantity, match_method, confirmed_by, created_at, updated_at
     ) VALUES (?, ?, 5, 'manual', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [planItem.insertId, productionItem.insertId, admin.userId],
  );
  const productionCreate = { orderItemId:productionItem.insertId, factoryId:factory.insertId,
    bomId:productionBom.insertId, plannedQuantity:5, plannedStartDate:"2026-08-15", plannedFinishDate:"2026-08-31" };
  const productionCreated = await app.inject({ method:"POST", url:"/api/v1/production-orders",
    headers:headers(admin, "manufacturing.order.create", productionCreate), payload:productionCreate });
  assert.equal(productionCreated.statusCode, 201, productionCreated.body);
  const amplified = { ...productionCreate, plannedQuantity:1 };
  const amplifiedResponse = await app.inject({ method:"POST", url:"/api/v1/production-orders",
    headers:headers(admin, "manufacturing.order.create", amplified), payload:amplified });
  assert.equal(amplifiedResponse.statusCode, 409, amplifiedResponse.body);
  const otherFactory = await db.execute(
    `INSERT INTO factories (name, code, status, created_at, updated_at)
     VALUES ('R3 Other Factory', ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`, [`R3-F-OTHER-${suffix}`],
  );
  const crossFactory = { ...productionCreate, factoryId:otherFactory.insertId, plannedQuantity:1 };
  const crossFactoryResponse = await app.inject({ method:"POST", url:"/api/v1/production-orders",
    headers:headers(admin, "manufacturing.order.create", crossFactory), payload:crossFactory });
  assert.equal(crossFactoryResponse.statusCode, 403, crossFactoryResponse.body);
  const forbiddenTransfer = {
    fromWarehouseId: warehouse.insertId, toWarehouseId: otherWarehouse.insertId,
    sku: "R3-SKU", quantity: 1, reason: "binding oracle",
  };
  const forbiddenTransferResponse = await app.inject({
    method: "POST", url: "/api/v1/inventory/transfers",
    headers: headers(factoryActor, "inventory.transfer.request", forbiddenTransfer),
    payload: forbiddenTransfer,
  });
  assert.equal(forbiddenTransferResponse.statusCode, 403);
  const paymentRequest = await db.execute(
    `INSERT INTO factory_payment_requests (
       request_no, factory_id, actual_shipment_date, planned_payment_date,
       total_amount_minor, auto_generated, status, invoice_covered_amount_minor,
       maintained_by, created_at, updated_at
     ) VALUES (?, ?, CURRENT_DATE(), ?, 100, 1, 'generated', 100, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-PAY-${suffix}`, factory.insertId, `2099-12-${String((Date.now() % 20) + 10).padStart(2, "0")}`, admin.userId],
  );
  const [versionRow] = await db.query(
    `SELECT CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
     FROM factory_payment_requests WHERE id = ?`, [paymentRequest.insertId],
  );
  const paymentBase = (amountMinor, bankReference) => ({
    action: "record_payment",
    paymentRequestId: paymentRequest.insertId,
    amountMinor,
    paidAt: "2026-08-12",
    bankReference,
  });
  const paymentInputs = [paymentBase(70, `R3-BANK-A-${suffix}`), paymentBase(50, `R3-BANK-B-${suffix}`)];
  const paymentPayloads = [];
  for (const input of paymentInputs) {
    const challengeNo = await challenge(db, admin, {
      action: "record_payment", objectType: "finance:record_payment",
      objectId: paymentRequest.insertId, objectVersion: Number(versionRow.objectVersion), requestDigest: payloadDigest(input),
    });
    paymentPayloads.push({ ...input, challengeNo });
  }
  const paymentResponses = await Promise.all(paymentPayloads.map((payload) => app.inject({
    method: "POST", url: "/api/v1/finance",
    headers: headers(admin, "finance.command", payload), payload,
  })));
  const paymentDiagnostics = paymentResponses.map((response) => ({ statusCode: response.statusCode, body: response.json() }));
  assert.equal(paymentResponses.filter((response) => response.statusCode === 201).length, 1, JSON.stringify(paymentDiagnostics));
  assert.equal(paymentResponses.filter((response) => response.statusCode === 409).length, 1, JSON.stringify(paymentDiagnostics));
  const [paymentTotal] = await db.query(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payment_records
     WHERE payment_request_id = ? AND record_type = 'payment'`, [paymentRequest.insertId],
  );
  assert.ok(Number(paymentTotal.total) === 50 || Number(paymentTotal.total) === 70);
  assert.ok(Number(paymentTotal.total) <= 100);

  const [originalPayment] = await db.query(
    `SELECT id, amount_minor AS amountMinor FROM payment_records
     WHERE payment_request_id = ? AND record_type = 'payment' LIMIT 1`, [paymentRequest.insertId],
  );
  const correctionApproval = await db.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'financial_record_correction', 'payment_record', ?, 'correction oracle', ?,
               1, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-CORR-APR-${suffix}`, originalPayment.id, JSON.stringify({
      proposedPaymentRequestId:paymentRequest.insertId, proposedAmountMinor:Number(originalPayment.amountMinor),
      proposedPaidAt:"2026-08-12", proposedBankReference:`R3-CORRECTED-${suffix}`,
    }), financeOnly.userId],
  );
  const [correctionVersion] = await db.query(
    `SELECT CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
     FROM approval_requests WHERE id = ?`, [correctionApproval.insertId],
  );
  const correctionDecision = { id:correctionApproval.insertId, decision:"approved", comment:"approve correction" };
  const correctionChallenge = await challenge(db, admin, {
    action:"review", objectType:"approval", objectId:correctionApproval.insertId,
    objectVersion:Number(correctionVersion.objectVersion), requestDigest:payloadDigest(correctionDecision),
  });
  const correctionResponse = await app.inject({ method:"POST", url:"/api/v1/approvals",
    headers:headers(admin, "approvals.decide", { ...correctionDecision, challengeNo:correctionChallenge }),
    payload:{ ...correctionDecision, challengeNo:correctionChallenge } });
  assert.equal(correctionResponse.statusCode, 200, correctionResponse.body);
  const correctionRelations = await db.query(
    `SELECT record_type AS recordType, reverses_payment_record_id AS reversesId,
            corrects_payment_record_id AS correctsId
     FROM payment_records WHERE reverses_payment_record_id = ? OR corrects_payment_record_id = ?
     ORDER BY id ASC`, [originalPayment.id, originalPayment.id],
  );
  assert.deepEqual(correctionRelations.map((row) => [row.recordType, row.reversesId, row.correctsId]), [
    ["reversal", originalPayment.id, null], ["correction", null, originalPayment.id],
  ]);

  const purchaseOrder = await db.execute(
    `INSERT INTO purchase_orders (order_no, status, total_tax_included_minor, created_at, updated_at)
     VALUES (?, 'active', 100, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`, [`R3-PO-${suffix}`],
  );
  const invoice = await db.execute(
    `INSERT INTO factory_invoices (
       factory_id, purchase_order_id, coverage_mode, invoice_no, invoice_type,
       amount_tax_included_minor, tax_amount_minor, issued_at, status,
       expected_amount_minor, amount_matches_expected, maintained_by, created_at, updated_at
     ) VALUES (?, ?, 'full_order', ?, 'vat_special', 100, 10, CURRENT_DATE(),
               'invalidated', 100, 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [factory.insertId, purchaseOrder.insertId, `R3-INV-${suffix}`, admin.userId],
  );
  const invoiceException = await db.execute(
    `INSERT INTO invoice_exceptions (
       invoice_id, exception_type, affected_amount_minor, replacement_deadline,
       status, reason, created_by, created_at, updated_at
     ) VALUES (?, 'voided', 60, '2099-12-31', 'awaiting_remediation',
               'refund race', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [invoice.insertId, admin.userId],
  );
  await db.execute(
    `INSERT INTO invoice_payment_allocations (
       invoice_id, payment_request_id, allocated_amount_minor, status, created_by, created_at, updated_at
     ) VALUES (?, ?, 100, 'frozen', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [invoice.insertId, paymentRequest.insertId, admin.userId],
  );
  const invalidatedVerification = { action:"verify_invoice", invoiceId:invoice.insertId,
    verifierRole:"finance", decision:"approved" };
  const invalidatedResponse = await app.inject({ method:"POST", url:"/api/v1/finance",
    headers:headers(admin, "finance.command", invalidatedVerification), payload:invalidatedVerification });
  assert.equal(invalidatedResponse.statusCode, 409, invalidatedResponse.body);
  const [exceptionVersion] = await db.query(
    `SELECT CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
     FROM invoice_exceptions WHERE id = ?`, [invoiceException.insertId],
  );
  const refundInputs = [30, 40].map((amountMinor, index) => ({
    action: "record_refund", invoiceExceptionId: invoiceException.insertId,
    paymentRequestId: paymentRequest.insertId, amountMinor, paidAt: "2026-08-12",
    bankReference: `R3-REFUND-${index}-${suffix}`,
  }));
  const unrelatedRequest = await db.execute(
    `INSERT INTO factory_payment_requests (
       request_no, factory_id, actual_shipment_date, planned_payment_date,
       total_amount_minor, auto_generated, status, invoice_covered_amount_minor,
       maintained_by, created_at, updated_at
     ) VALUES (?, ?, CURRENT_DATE(), '2099-12-31', 100, 1, 'paid', 100, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-PAY-UNRELATED-${suffix}`, factory.insertId, admin.userId],
  );
  await db.execute(
    `INSERT INTO payment_records (
       payment_request_id, amount_minor, paid_at, bank_reference, record_type,
       recorded_by, review_status, created_at, updated_at
     ) VALUES (?, 100, CURRENT_DATE(), ?, 'payment', ?, 'not_required', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [unrelatedRequest.insertId, `R3-UNRELATED-PAID-${suffix}`, admin.userId],
  );
  const wrongRefund = { ...refundInputs[0], paymentRequestId:unrelatedRequest.insertId,
    bankReference:`R3-WRONG-REFUND-${suffix}` };
  const wrongChallenge = await challenge(db, admin, {
    action:"record_refund", objectType:"finance:record_refund", objectId:invoiceException.insertId,
    objectVersion:Number(exceptionVersion.objectVersion), requestDigest:payloadDigest(wrongRefund),
  });
  const wrongRefundResponse = await app.inject({ method:"POST", url:"/api/v1/finance",
    headers:headers(admin, "finance.command", { ...wrongRefund, challengeNo:wrongChallenge }),
    payload:{ ...wrongRefund, challengeNo:wrongChallenge } });
  assert.equal(wrongRefundResponse.statusCode, 409, wrongRefundResponse.body);
  const refundPayloads = [];
  for (const input of refundInputs) {
    const challengeNo = await challenge(db, admin, {
      action: "record_refund", objectType: "finance:record_refund",
      objectId: invoiceException.insertId, objectVersion: Number(exceptionVersion.objectVersion),
      requestDigest: payloadDigest(input),
    });
    refundPayloads.push({ ...input, challengeNo });
  }
  const refundResponses = await Promise.all(refundPayloads.map((payload) => app.inject({
    method: "POST", url: "/api/v1/finance",
    headers: headers(admin, "finance.command", payload), payload,
  })));
  const refundDiagnostics = refundResponses.map((response, index) => ({ payload: refundPayloads[index], statusCode: response.statusCode, body: response.json() }));
  assert.equal(refundResponses.filter((response) => response.statusCode === 201).length, 1, JSON.stringify(refundDiagnostics));
  assert.equal(refundResponses.filter((response) => response.statusCode === 409).length, 1, JSON.stringify(refundDiagnostics));
  const [refundState] = await db.query(
    `SELECT e.refunded_amount_minor AS refundedAmountMinor,
            (SELECT COUNT(*) FROM payment_records p
             WHERE p.invoice_exception_id = e.id AND p.record_type = 'refund') AS refundRows
     FROM invoice_exceptions e WHERE e.id = ?`, [invoiceException.insertId],
  );
  assert.ok([30, 40].includes(Number(refundState.refundedAmountMinor)));
  assert.equal(Number(refundState.refundRows), 1);

  const correctionRequestA = await db.execute(
    `INSERT INTO factory_payment_requests (
       request_no, factory_id, actual_shipment_date, planned_payment_date,
       total_amount_minor, auto_generated, status, invoice_covered_amount_minor,
       paid_at, maintained_by, created_at, updated_at
     ) VALUES (?, ?, CURRENT_DATE(), '2099-11-01', 100, 1, 'paid', 100,
               '2026-08-12', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-REFCORR-A-${suffix}`, factory.insertId, admin.userId],
  );
  const correctionRequestB = await db.execute(
    `INSERT INTO factory_payment_requests (
       request_no, factory_id, actual_shipment_date, planned_payment_date,
       total_amount_minor, auto_generated, status, invoice_covered_amount_minor,
       paid_at, maintained_by, created_at, updated_at
     ) VALUES (?, ?, CURRENT_DATE(), '2099-11-02', 100, 1, 'paid', 100,
               '2026-08-12', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-REFCORR-B-${suffix}`, factory.insertId, admin.userId],
  );
  for (const [requestId, reference] of [
    [correctionRequestA.insertId, `R3-REFCORR-PAY-A-${suffix}`],
    [correctionRequestB.insertId, `R3-REFCORR-PAY-B-${suffix}`],
  ]) {
    await db.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         recorded_by, review_status, created_at, updated_at
       ) VALUES (?, 100, '2026-08-12', ?, 'payment', ?, 'not_required', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [requestId, reference, admin.userId],
    );
  }
  const correctionInvoice = await db.execute(
    `INSERT INTO factory_invoices (
       factory_id, purchase_order_id, coverage_mode, invoice_no, invoice_type,
       amount_tax_included_minor, tax_amount_minor, issued_at, status,
       expected_amount_minor, amount_matches_expected, maintained_by, created_at, updated_at
     ) VALUES (?, ?, 'full_order', ?, 'vat_special', 100, 10, CURRENT_DATE(),
               'invalidated', 100, 1, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [factory.insertId, purchaseOrder.insertId, `R3-REFCORR-INV-${suffix}`, admin.userId],
  );
  const correctionException = await db.execute(
    `INSERT INTO invoice_exceptions (
       invoice_id, exception_type, affected_amount_minor, replacement_deadline,
       refunded_amount_minor, status, reason, created_by, created_at, updated_at
     ) VALUES (?, 'voided', 50, '2099-12-31', 20, 'awaiting_remediation',
               'refund correction oracle', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [correctionInvoice.insertId, admin.userId],
  );
  await db.execute(
    `INSERT INTO invoice_payment_allocations (
       invoice_id, payment_request_id, allocated_amount_minor, status, created_by, created_at, updated_at
     ) VALUES (?, ?, 100, 'frozen', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [correctionInvoice.insertId, correctionRequestA.insertId, admin.userId],
  );
  const refundToCorrect = await db.execute(
    `INSERT INTO payment_records (
       payment_request_id, amount_minor, paid_at, bank_reference, record_type,
       invoice_exception_id, recorded_by, review_status, created_at, updated_at
     ) VALUES (?, 20, '2026-08-12', ?, 'refund', ?, ?, 'not_required', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [correctionRequestA.insertId, `R3-REFCORR-REFUND-${suffix}`, correctionException.insertId, financeOnly.userId],
  );
  async function approveRefundCorrection(proposedRequestId, reference, label) {
    const approval = await db.execute(
      `INSERT INTO approval_requests (
         request_no, workflow_type, entity_type, entity_id, summary, payload_json,
         high_risk, status, requested_by, requested_at, created_at, updated_at
       ) VALUES (?, 'financial_record_correction', 'payment_record', ?, ?, ?,
                 1, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [`R3-REFCORR-APR-${label}-${suffix}`, refundToCorrect.insertId, `refund correction ${label}`,
       JSON.stringify({ proposedPaymentRequestId:proposedRequestId, proposedAmountMinor:10,
         proposedPaidAt:"2026-08-13", proposedBankReference:reference }), financeOnly.userId],
    );
    const [version] = await db.query(
      `SELECT CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
       FROM approval_requests WHERE id = ?`, [approval.insertId],
    );
    const decision = { id:approval.insertId, decision:"approved", comment:`refund correction ${label}` };
    const challengeNo = await challenge(db, admin, { action:"review", objectType:"approval",
      objectId:approval.insertId, objectVersion:Number(version.objectVersion), requestDigest:payloadDigest(decision) });
    return app.inject({ method:"POST", url:"/api/v1/approvals",
      headers:headers(admin, "approvals.decide", { ...decision, challengeNo }),
      payload:{ ...decision, challengeNo } });
  }
  const crossBoundCorrection = await approveRefundCorrection(
    correctionRequestB.insertId, `R3-REFCORR-WRONG-${suffix}`, "wrong-request",
  );
  assert.equal(crossBoundCorrection.statusCode, 409, crossBoundCorrection.body);
  const correctedRefundResponse = await approveRefundCorrection(
    correctionRequestA.insertId, `R3-REFCORR-CORRECT-${suffix}`, "same-request",
  );
  assert.equal(correctedRefundResponse.statusCode, 200, correctedRefundResponse.body);
  const [refundCorrectionProjection] = await db.query(
    `SELECT pr.status, pr.paid_at AS paidAt, e.refunded_amount_minor AS refundedAmountMinor,
            (SELECT SUM(CASE WHEN p.invoice_exception_id IS NULL THEN p.amount_minor ELSE 0 END)
             FROM payment_records p WHERE p.payment_request_id = pr.id) AS normalPaidNet,
            (SELECT SUM(p.amount_minor) FROM payment_records p
             WHERE p.invoice_exception_id = e.id) AS authoritativeRefundNet
     FROM factory_payment_requests pr JOIN invoice_exceptions e ON e.id = ?
     WHERE pr.id = ?`, [correctionException.insertId, correctionRequestA.insertId],
  );
  assert.deepEqual(
    [refundCorrectionProjection.status, String(refundCorrectionProjection.paidAt).slice(0, 10),
     Number(refundCorrectionProjection.normalPaidNet), Number(refundCorrectionProjection.authoritativeRefundNet),
     refundCorrectionProjection.refundedAmountMinor],
    ["paid", "2026-08-12", 100, 10, 10],
  );

  const userRole = await db.execute(
    `INSERT INTO user_roles (
       user_id, role_code, effective_from, status, requested_by, created_at, updated_at
     ) VALUES (?, 'company_qc', CURRENT_DATE(), 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [factoryActor.userId, financeOnly.userId],
  );
  const r1Approval = await db.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'user_role_change', 'user_role', ?, 'R1 role approval', '{"operation":"assign"}',
               0, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-R1-APR-${suffix}`, userRole.insertId, financeOnly.userId],
  );
  const r1Decision = { id:r1Approval.insertId, decision:"approved", comment:"R1 reachable" };
  const r1Response = await app.inject({ method:"POST", url:"/api/v1/approvals",
    headers:headers(admin, "approvals.decide", r1Decision), payload:r1Decision });
  assert.equal(r1Response.statusCode, 200, r1Response.body);
  const [r1State] = await db.query(`SELECT status, reviewed_by AS reviewedBy FROM user_roles WHERE id = ?`, [userRole.insertId]);
  assert.deepEqual([r1State.status, r1State.reviewedBy], ["active", admin.userId]);

  const r2Approval = await db.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'probe_workflow', 'r2_probe', 1, 'R2 adapter approval', '{}',
               1, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-R2-APR-${suffix}`, financeOnly.userId],
  );
  await db.execute(
    `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES ('approval_request', ?, 7, CURRENT_TIMESTAMP(3))`, [String(r2Approval.insertId)],
  );
  const r2Decision = { id:r2Approval.insertId, decision:"approved", comment:"R2 reachable" };
  const r2Challenge = await challenge(db, admin, {
    action:"approve", objectType:"r2:approval_request", objectId:r2Approval.insertId,
    objectVersion:7, requestDigest:payloadDigest(r2Decision),
  });
  const r2Response = await app.inject({ method:"POST", url:"/api/v1/approvals",
    headers:headers(admin, "approvals.decide", { ...r2Decision, challengeNo:r2Challenge }),
    payload:{ ...r2Decision, challengeNo:r2Challenge } });
  assert.equal(r2Response.statusCode, 200, r2Response.body);
  const [r2Version] = await db.query(
    `SELECT version FROM resource_versions WHERE resource_type = 'approval_request' AND resource_id = ?`,
    [String(r2Approval.insertId)],
  );
  assert.equal(r2Version.version, 8);

  const transfer = await db.execute(
    `INSERT INTO inventory_transfers (
       transfer_no, from_warehouse_id, to_warehouse_id, sku, quantity, reason,
       status, requested_by, created_at, updated_at
     ) VALUES (?, ?, ?, 'R3-SKU', 1, 'approval race', 'pending_supply_chain', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-TR-${suffix}`, warehouse.insertId, warehouse.insertId, financeOnly.userId],
  );
  const approval = await db.execute(
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, 'warehouse_transfer', 'inventory_transfer', ?, 'R3 approval race', '{}',
               0, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`R3-APR-${suffix}`, transfer.insertId, financeOnly.userId],
  );
  const deniedPayload = { id: approval.insertId, decision: "approved", comment: "forbidden" };
  const denied = await app.inject({
    method: "POST", url: "/api/v1/approvals",
    headers: headers(financeOnly, "approvals.decide", deniedPayload), payload: deniedPayload,
  });
  assert.equal(denied.statusCode, 403);

  const decisionPayload = { id: approval.insertId, decision: "approved", comment: "approved" };
  const decisions = await Promise.all([1, 2].map(() => app.inject({
    method: "POST", url: "/api/v1/approvals",
    headers: headers(admin, "approvals.decide", decisionPayload), payload: decisionPayload,
  })));
  assert.equal(decisions.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(decisions.filter((response) => response.statusCode === 409).length, 1);
  const [approvalState] = await db.query(
    `SELECT status, reviewed_by AS reviewedBy FROM approval_requests WHERE id = ?`, [approval.insertId],
  );
  const [transferState] = await db.query(
    `SELECT status, approved_by AS approvedBy FROM inventory_transfers WHERE id = ?`, [transfer.insertId],
  );
  assert.deepEqual([approvalState.status, approvalState.reviewedBy, transferState.status, transferState.approvedBy],
    ["approved", admin.userId, "approved", admin.userId]);

  const [evidence] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM audit_logs WHERE actor_user_id = ?) AS audits,
       (SELECT COUNT(*) FROM outbox_messages WHERE deduplication_key LIKE 'r3:%') AS outboxRows,
       (SELECT COUNT(*) FROM command_idempotency WHERE status = 'completed' AND command_name LIKE '%approval%') AS approvalCommands`,
    [admin.userId],
  );
  assert.ok(Number(evidence.audits) >= 4);
  assert.ok(Number(evidence.outboxRows) >= 4);
  assert.ok(Number(evidence.approvalCommands) >= 4);
});
