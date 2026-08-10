import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const source = fs.readFileSync(
  new URL("../app/lib/business-rules.ts", import.meta.url),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(transpiled, {
  module,
  exports: module.exports,
  require,
});
const {
  evaluateInspection,
  calculateReservation,
  calculateExpiryStatus,
  calculatePlannedPaymentDate,
  toMysqlDateTime,
} = module.exports;

test("默认质检标准为95%，低于标准的抽检转全检并隔离", () => {
  const result = evaluateInspection({
    inspectedQuantity: 100,
    passedQuantity: 94,
    inspectionMethod: "sampling",
  });
  assert.equal(result.systemResult, "failed");
  assert.equal(result.quarantineTriggered, true);
  assert.equal(result.fullInspectionRequired, true);
});

test("全检失败不会再次生成全检要求", () => {
  const result = evaluateInspection({
    inspectedQuantity: 100,
    passedQuantity: 90,
    inspectionMethod: "full",
  });
  assert.equal(result.systemResult, "failed");
  assert.equal(result.fullInspectionRequired, false);
});

test("库存不足时只计算缺口，不允许产生负库存", () => {
  const result = calculateReservation(30, 50);
  assert.equal(result.reservedQuantity, 30);
  assert.equal(result.shortageQuantity, 20);
  assert.equal(result.canReserveInFull, false);
});

test("保质期剩余一半黄灯、四分之一红灯、到期冻结", () => {
  assert.equal(
    calculateExpiryStatus({
      productionDate: "2026-01-01",
      expiryDate: "2027-01-01",
      today: "2026-07-03",
    }),
    "yellow",
  );
  assert.equal(
    calculateExpiryStatus({
      productionDate: "2026-01-01",
      expiryDate: "2027-01-01",
      today: "2026-10-02",
    }),
    "red",
  );
  assert.equal(
    calculateExpiryStatus({
      productionDate: "2026-01-01",
      expiryDate: "2027-01-01",
      today: "2027-01-01",
    }),
    "expired_frozen",
  );
});

test("月结规则在25日前发货次月25日付款，25日后下下月付款", () => {
  assert.equal(
    calculatePlannedPaymentDate({
      shippedAt: "2026-07-25T08:00:00Z",
      mode: "monthly_cutoff",
      cutoffDay: 25,
      paymentDay: 25,
    }),
    "2026-08-25",
  );
  assert.equal(
    calculatePlannedPaymentDate({
      shippedAt: "2026-07-26T08:00:00Z",
      mode: "monthly_cutoff",
      cutoffDay: 25,
      paymentDay: 25,
    }),
    "2026-09-25",
  );
});

test("发货后天数付款规则按实际发货日计算", () => {
  assert.equal(
    calculatePlannedPaymentDate({
      shippedAt: "2026-07-29T08:00:00Z",
      mode: "shipment_plus_days",
      daysAfterShipment: 30,
    }),
    "2026-08-28",
  );
});

test("RDS写入前将ISO时间转换为MySQL DATETIME格式", () => {
  assert.equal(
    toMysqlDateTime("2026-07-29T18:30:45.123Z"),
    "2026-07-29 18:30:45.123",
  );
  assert.equal(toMysqlDateTime("2026-07-29"), "2026-07-29");
});
