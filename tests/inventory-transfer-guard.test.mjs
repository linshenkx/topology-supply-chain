import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const sourceUrl = new URL("../apps/web/app/lib/inventory-transfer-guard.ts", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const testModule = { exports: {} };
vm.runInNewContext(transpiled, {
  module: testModule,
  exports: testModule.exports,
  Number,
  Math,
  RangeError,
});
const {
  INVENTORY_TRANSFER_TRANSITIONS,
  mutationAffectedExactlyOnce,
  planInventoryTransferDeductions,
} = testModule.exports;

test("调拨发出和收货只能从各自的前置状态原子迁移", () => {
  assert.equal(INVENTORY_TRANSFER_TRANSITIONS.ship.from, "approved");
  assert.equal(INVENTORY_TRANSFER_TRANSITIONS.ship.to, "shipped");
  assert.equal(INVENTORY_TRANSFER_TRANSITIONS.receive.from, "shipped");
  assert.equal(INVENTORY_TRANSFER_TRANSITIONS.receive.to, "received");
});

test("CAS和条件扣库仅接受恰好一行受影响", () => {
  assert.equal(mutationAffectedExactlyOnce(1), true);
  assert.equal(mutationAffectedExactlyOnce(0), false);
  assert.equal(mutationAffectedExactlyOnce(2), false);
});

test("批次扣减计划按顺序覆盖调拨数量且不超扣", () => {
  const result = planInventoryTransferDeductions([
    { id: 11, availableQuantity: 5 },
    { id: 12, availableQuantity: 4 },
  ], 8);

  assert.equal(result.remaining, 0);
  assert.equal(result.deductions.length, 2);
  assert.equal(result.deductions[0].batchId, 11);
  assert.equal(result.deductions[0].quantity, 5);
  assert.equal(result.deductions[1].batchId, 12);
  assert.equal(result.deductions[1].quantity, 3);
});

test("批次库存不足时保留未扣减数量", () => {
  const result = planInventoryTransferDeductions([
    { id: 11, availableQuantity: 5 },
    { id: 12, availableQuantity: 4 },
  ], 10);

  assert.equal(result.remaining, 1);
});

test("路由在副作用前完成状态CAS，并对每批库存使用余额条件", () => {
  const route = fs.readFileSync(
    new URL("../apps/web/app/api/inventory/transfers/route.ts", import.meta.url),
    "utf8",
  );
  const shipTransaction = route.indexOf("const transition = INVENTORY_TRANSFER_TRANSITIONS.ship");
  const shipStateGuard = route.indexOf("eq(inventoryTransfers.status, transition.from)", shipTransaction);
  const firstBatchUpdate = route.indexOf("tx.update(inventoryBatches)", shipTransaction);
  const receiveTransaction = route.indexOf("const transition = INVENTORY_TRANSFER_TRANSITIONS.receive");
  const receiveStateGuard = route.indexOf("eq(inventoryTransfers.status, transition.from)", receiveTransaction);
  const inboundInsert = route.indexOf("tx.insert(inventoryBatches)", receiveTransaction);

  assert.ok(shipTransaction >= 0);
  assert.ok(shipStateGuard > shipTransaction && shipStateGuard < firstBatchUpdate);
  assert.ok(receiveTransaction > shipTransaction);
  assert.ok(receiveStateGuard > receiveTransaction && receiveStateGuard < inboundInsert);
  assert.match(route, /gte\(inventoryBatches\.availableQuantity, deduction\.quantity\)/);
  assert.match(route, /if \(remaining !== 0\)/);
});
