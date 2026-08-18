import assert from "node:assert/strict";
import test from "node:test";

import mysql from "mysql2/promise";

import { buildApp } from "../dist/app.js";
import { createDatabaseClient } from "../dist/infrastructure/database.js";
import manifest from "../dist/composition/supply-writes-manifest.js";
import { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "../dist/platform/approvals.js";
import { requireWriterFence } from "../dist/platform/commands.js";
import { enqueueOutbox } from "../dist/platform/outbox.js";
import { FileAuthorizationRegistry } from "../dist/platform/registrations.js";

const databaseUrl = process.env.MYSQL_SUPPLY_TEST_URL?.trim();
const TOKEN = "cd".repeat(32);

function createMysqlPoolWithConnectionErrorListener(options) {
  const pool = mysql.createPool(options);
  pool.pool.on("connection", (connection) => {
    connection.on("error", () => undefined);
  });

  return {
    end: () => pool.end(),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        destroy: () => connection.destroy(),
        execute: (queryOptions, params) => connection.execute(queryOptions, params),
        ping: () => connection.ping(),
        query: (queryOptions, params) => connection.query(queryOptions, params),
        release: () => connection.release(),
        rollback: () => connection.rollback(),
      };
    },
  };
}

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
    challengeNo: `r2-master-data-${suffix}-${approvalId}-${action}`,
    objectId: String(approvalId),
    objectType: "r2:approval_request",
    objectVersion: 1,
    requestDigest: "34".repeat(32),
    sessionId: 1,
    userId: reviewerId,
  };
}

test("master-data writes resubmit rejected SKUs and gate duplicate BOM versions on real MySQL", {
  skip: !databaseUrl && "set MYSQL_SUPPLY_TEST_URL to run master-data MySQL integration",
  timeout: 120_000,
}, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  let keySequence = 0;
  const nextKey = (label) => `r2-master-data-${label}-${suffix}-${++keySequence}`;
  const db = createDatabaseClient({
    env: {
      DATABASE_URL: databaseUrl,
      DB_SSL: "disabled",
      DB_POOL_SIZE: "4",
      DB_QUERY_TIMEOUT_MS: "30000",
      DB_TRANSACTION_TIMEOUT_MS: "30000",
    },
    poolFactory: createMysqlPoolWithConnectionErrorListener,
  });
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

  const requestorId = await insert(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status, created_at, updated_at
     ) VALUES (?, ?, 'Master data requester', 'supply_chain', 'Topology', 'active',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`master-data-requester-${suffix}@example.com`, `136${String(Date.now()).slice(-8)}`],
  );
  const reviewerId = await insert(
    `INSERT INTO users (
       email, mobile, name, role, organization_name, account_status, created_at, updated_at
     ) VALUES (?, ?, 'Master data reviewer', 'supply_chain', 'Topology', 'active',
               CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [`master-data-reviewer-${suffix}@example.com`, `137${String(Date.now() + 1).slice(-8)}`],
  );

  await db.execute(
    `INSERT INTO writer_fences (resource, owner, enabled, generation, updated_at)
     VALUES ('r2.master-data.write', 'fastify-v1', 1, 2, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE owner = VALUES(owner), enabled = 1, generation = 2, updated_at = CURRENT_TIMESTAMP(3)`,
  );

  access = {
    sessionId: 1,
    userId: requestorId,
    email: "requester@example.com",
    name: "Master data requester",
    roles: ["supply_chain"],
    factoryId: null,
    supplierId: null,
    organizationName: "Topology",
    localPreview: false,
  };

  const createSku = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-create")),
    payload: {
      action: "create_sku",
      code: `MD-SKU-${suffix}`,
      name: "Rejected SKU",
      itemType: "finished",
      stockUnit: "pcs",
      purchaseUnit: "box",
      purchaseUnitQuantity: 2,
      stockUnitQuantity: 10,
      effectiveFrom: "2099-01-01",
      overproductionTolerance: 1,
      purchaseOverTolerance: 2,
      purchaseUnderTolerance: 3,
    },
  });
  assert.equal(createSku.statusCode, 201, createSku.body);
  const skuId = createSku.json().result.sku.id;
  let approvalRows = await db.query(
    "SELECT id FROM approval_requests WHERE entity_type = 'sku' AND entity_id = ? ORDER BY id DESC",
    [skuId],
  );
  const approvalEffect = approvalEffects.resolve("r2.sku_verification");
  await db.transaction((transaction) =>
    approvalEffect.execute({
      transaction,
      claim: claim(approvalRows[0].id, reviewerId, "reject", suffix),
    }),
  );
  await db.execute(
    `UPDATE approval_requests
     SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP(3),
         review_comment = '规格不完整', updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [reviewerId, approvalRows[0].id],
  );

  let rows = await db.query(
    `SELECT verification_status AS verificationStatus, status, name,
            overproduction_tolerance_bps AS overproductionToleranceBps,
            purchase_over_tolerance_bps AS purchaseOverToleranceBps,
            purchase_under_tolerance_bps AS purchaseUnderToleranceBps
     FROM skus WHERE id = ?`,
    [skuId],
  );
  assert.deepEqual(rows[0], {
    verificationStatus: "rejected",
    status: "draft",
    name: "Rejected SKU",
    overproductionToleranceBps: 100,
    purchaseOverToleranceBps: 200,
    purchaseUnderToleranceBps: 300,
  });

  const resubmitKey = nextKey("sku-resubmit");
  const resubmitHeaders = headers(resubmitKey);
  const resubmitPayload = {
    action: "resubmit_sku",
    id: skuId,
    name: "Rejected SKU Fixed",
    itemType: "component",
    stockUnit: "box",
    purchaseUnit: "carton",
    purchaseUnitQuantity: 3,
    stockUnitQuantity: 12,
    effectiveFrom: "2099-02-01",
    overproductionTolerance: 4,
    purchaseOverTolerance: 5,
    purchaseUnderTolerance: 6,
  };

  const resubmit = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: resubmitHeaders,
    payload: resubmitPayload,
  });
  assert.equal(resubmit.statusCode, 201, resubmit.body);
  assert.equal(resubmit.json().result.sku.id, skuId);
  assert.equal(resubmit.json().result.sku.code, `MD-SKU-${suffix}`);
  assert.equal(resubmit.json().result.sku.verificationStatus, "pending");

  rows = await db.query(
    `SELECT verification_status AS verificationStatus, status, name, item_type AS itemType,
            stock_unit AS stockUnit, overproduction_tolerance_bps AS overproductionToleranceBps,
            purchase_over_tolerance_bps AS purchaseOverToleranceBps,
            purchase_under_tolerance_bps AS purchaseUnderToleranceBps
     FROM skus WHERE id = ?`,
    [skuId],
  );
  assert.deepEqual(rows[0], {
    verificationStatus: "pending",
    status: "draft",
    name: "Rejected SKU Fixed",
    itemType: "component",
    stockUnit: "box",
    overproductionToleranceBps: 400,
    purchaseOverToleranceBps: 500,
    purchaseUnderToleranceBps: 600,
  });

  rows = await db.query(
    `SELECT purchase_unit AS purchaseUnit, stock_unit AS stockUnit,
            purchase_unit_quantity AS purchaseUnitQuantity,
            stock_unit_quantity AS stockUnitQuantity,
            effective_from AS effectiveFrom, status
     FROM sku_unit_conversions WHERE sku_id = ? ORDER BY id DESC`,
    [skuId],
  );
  assert.equal(rows[0].purchaseUnit, "carton");
  assert.equal(rows[0].stockUnit, "box");
  assert.equal(rows[0].purchaseUnitQuantity, 3);
  assert.equal(rows[0].stockUnitQuantity, 12);
  assert.equal(rows[0].effectiveFrom, "2099-02-01");
  assert.equal(rows[0].status, "active");

  approvalRows = await db.query(
    "SELECT id FROM approval_requests WHERE entity_type = 'sku' AND entity_id = ? ORDER BY id DESC",
    [skuId],
  );
  assert.equal(approvalRows.length, 2);
  rows = await db.query(
    "SELECT status, review_comment AS reviewComment FROM approval_requests WHERE id = ?",
    [approvalRows[1].id],
  );
  assert.deepEqual(rows[0], { status: "rejected", reviewComment: "规格不完整" });

  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: resubmitHeaders,
    payload: resubmitPayload,
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().command.replayed, true);

  const reused = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: resubmitHeaders,
    payload: {
      action: "resubmit_sku",
      id: skuId,
      name: "Rejected SKU Fixed 2",
      itemType: "component",
      stockUnit: "box",
      purchaseUnit: "carton",
      purchaseUnitQuantity: 3,
      stockUnitQuantity: 12,
      effectiveFrom: "2099-02-01",
      overproductionTolerance: 4,
      purchaseOverTolerance: 5,
      purchaseUnderTolerance: 6,
    },
  });
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().code, "IDEMPOTENCY_KEY_REUSED");

  const pendingSku = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-pending")),
    payload: {
      action: "create_sku",
      code: `MD-PENDING-${suffix}`,
      name: "Pending SKU",
      itemType: "finished",
      stockUnit: "pcs",
      overproductionTolerance: 1,
      purchaseOverTolerance: 2,
      purchaseUnderTolerance: 3,
    },
  });
  assert.equal(pendingSku.statusCode, 201, pendingSku.body);
  const pendingSkuId = pendingSku.json().result.sku.id;
  const pendingRejected = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-pending-resubmit")),
    payload: {
      action: "resubmit_sku",
      id: pendingSkuId,
      name: "Pending SKU",
      itemType: "finished",
      stockUnit: "pcs",
      overproductionTolerance: 1,
      purchaseOverTolerance: 2,
      purchaseUnderTolerance: 3,
    },
  });
  assert.equal(pendingRejected.statusCode, 409);

  await db.execute("UPDATE skus SET verification_status = 'approved', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [pendingSkuId]);
  const approvedRejected = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-approved-resubmit")),
    payload: {
      action: "resubmit_sku",
      id: pendingSkuId,
      name: "Approved SKU",
      itemType: "finished",
      stockUnit: "pcs",
      overproductionTolerance: 1,
      purchaseOverTolerance: 2,
      purchaseUnderTolerance: 3,
    },
  });
  assert.equal(approvedRejected.statusCode, 409);

  await db.execute("UPDATE skus SET verification_status = 'rejected', status = 'inactive', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [pendingSkuId]);
  const inactiveRejected = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-inactive-resubmit")),
    payload: {
      action: "resubmit_sku",
      id: pendingSkuId,
      name: "Inactive SKU",
      itemType: "finished",
      stockUnit: "pcs",
      overproductionTolerance: 1,
      purchaseOverTolerance: 2,
      purchaseUnderTolerance: 3,
    },
  });
  assert.equal(inactiveRejected.statusCode, 409);

  access = { ...access, roles: ["finance"] };
  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("sku-unauthorized")),
    payload: {
      action: "resubmit_sku",
      id: skuId,
      name: "Unauthorized SKU",
      itemType: "component",
      stockUnit: "box",
      overproductionTolerance: 4,
      purchaseOverTolerance: 5,
      purchaseUnderTolerance: 6,
    },
  });
  assert.equal(unauthorized.statusCode, 403);
  access = { ...access, roles: ["supply_chain"] };

  const finishedSku = `MD-BOM-FIN-${suffix}`;
  const componentSku = `MD-BOM-COMP-${suffix}`;
  const finishedId = await insert(
    `INSERT INTO skus (
       code, name, item_type, stock_unit, overproduction_tolerance_bps,
       purchase_over_tolerance_bps, purchase_under_tolerance_bps,
       verification_status, status, created_at, updated_at
     ) VALUES (?, ?, 'finished', 'pcs', 0, 0, 0, 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [finishedSku, finishedSku],
  );
  const componentId = await insert(
    `INSERT INTO skus (
       code, name, item_type, stock_unit, overproduction_tolerance_bps,
       purchase_over_tolerance_bps, purchase_under_tolerance_bps,
       verification_status, status, created_at, updated_at
     ) VALUES (?, ?, 'component', 'pcs', 0, 0, 0, 'approved', 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [componentSku, componentSku],
  );
  assert.ok(finishedId > 0 && componentId > 0);

  const bomCreate = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("bom-create")),
    payload: {
      action: "create_bom",
      finishedSku,
      version: "V1",
      effectiveFrom: "2099-03-01",
      effectiveTo: "",
      overlapAllowed: false,
      overlapReason: "",
      components: [{
        componentSku,
        quantityPerFinished: 1,
        isCore: true,
        issueTolerance: 0,
        consumptionTolerance: 0,
        lossTolerance: 0,
      }],
    },
  });
  assert.equal(bomCreate.statusCode, 201, bomCreate.body);
  const bomId = bomCreate.json().result.bom.id;
  const duplicateBom = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("bom-duplicate")),
    payload: {
      action: "create_bom",
      finishedSku,
      version: "V1",
      effectiveFrom: "2099-04-01",
      effectiveTo: "",
      overlapAllowed: false,
      overlapReason: "",
      components: [{
        componentSku,
        quantityPerFinished: 1,
        isCore: true,
        issueTolerance: 0,
        consumptionTolerance: 0,
        lossTolerance: 0,
      }],
    },
  });
  assert.equal(duplicateBom.statusCode, 409);

  const bomCopy = await app.inject({
    method: "POST",
    url: "/api/v1/master-data",
    headers: headers(nextKey("bom-copy")),
    payload: {
      action: "create_bom",
      finishedSku,
      version: "V2",
      effectiveFrom: "2099-04-01",
      effectiveTo: "",
      overlapAllowed: false,
      overlapReason: "",
      components: [{
        componentSku,
        quantityPerFinished: 2,
        isCore: true,
        issueTolerance: 0,
        consumptionTolerance: 0,
        lossTolerance: 0,
      }],
    },
  });
  assert.equal(bomCopy.statusCode, 201, bomCopy.body);
  assert.ok(bomCopy.json().result.bom.id !== bomId);
});
