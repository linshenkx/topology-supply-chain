import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadCommonJs(source, requireModule = require, globals = {}) {
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
    require: requireModule,
    Error,
    Map,
    Math,
    Number,
    Set,
    ...globals,
  });
  return testModule.exports;
}

const guardSource = fs.readFileSync(
  new URL("../apps/web/app/lib/payment-guard.ts", import.meta.url),
  "utf8",
);
const {
  evaluateExceptionRemediation,
  evaluatePayableLedger,
  evaluatePaymentCapacity,
  evaluateRefundCorrection,
  isPayableLedgerRecord,
} = loadCommonJs(guardSource);

const ledgerRecord = (amountMinor, recordType, invoiceExceptionId = null) => ({
  amountMinor,
  recordType,
  invoiceExceptionId,
});

test("serialized payments recompute the committed ledger and reject the second overpayment", () => {
  const first = evaluatePaymentCapacity({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(6_000, "payment")],
    incomingAmountMinor: 3_000,
  });
  assert.equal(first.ledgerWithinBounds, true);
  assert.equal(first.wouldExceed, false);
  assert.equal(first.remainingAmountMinor, 1_000);

  const second = evaluatePaymentCapacity({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(6_000, "payment"), ledgerRecord(3_000, "payment")],
    incomingAmountMinor: 2_000,
  });
  assert.equal(second.wouldExceed, true);
  assert.equal(second.totalPaidAmountMinor, 11_000);
});

test("payable ledger excludes refunds and refund corrections", () => {
  const records = [
    ledgerRecord(10_000, "payment"),
    ledgerRecord(-10_000, "reversal"),
    ledgerRecord(8_000, "correction"),
    ledgerRecord(3_000, "refund", 5),
    ledgerRecord(-3_000, "reversal", 5),
    ledgerRecord(2_500, "correction", 5),
  ];
  assert.deepEqual(records.map(isPayableLedgerRecord), [true, true, true, false, false, false]);
  const state = evaluatePayableLedger({ totalAmountMinor: 10_000, ledgerRecords: records });
  assert.equal(state.netPaidAmountMinor, 8_000);
  assert.equal(state.remainingAmountMinor, 2_000);
  assert.equal(state.withinBounds, true);
});

test("payable ledger signs, bounds and integer arithmetic fail closed", () => {
  assert.throws(() => evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(0, "payment")],
  }), /账本金额不合法/);
  assert.throws(() => evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(100, "reversal")],
  }), /账本金额不合法/);
  assert.throws(() => evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(100, "payment", 7)],
  }), /原始付款不能关联退款异常单/);
  assert.throws(() => evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(100, "refund")],
  }), /原始退款缺少关联异常单/);
  assert.throws(() => evaluatePaymentCapacity({
    totalAmountMinor: Number.MAX_SAFE_INTEGER,
    ledgerRecords: [ledgerRecord(Number.MAX_SAFE_INTEGER, "payment")],
    incomingAmountMinor: 1,
  }), /安全计算范围/);
  const negative = evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(100, "payment"), ledgerRecord(-200, "reversal")],
  });
  assert.equal(negative.withinBounds, false);
  const excessive = evaluatePayableLedger({
    totalAmountMinor: 10_000,
    ledgerRecords: [ledgerRecord(10_001, "payment")],
  });
  assert.equal(excessive.withinBounds, false);
});

test("exception remediation and refund correction enforce the affected amount", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(evaluateExceptionRemediation({
      affectedAmountMinor: 10_000,
      replacementCoveredAmountMinor: 4_000,
      refundedAmountMinor: 6_000,
    }))),
    { remediatedAmountMinor: 10_000, remainingAmountMinor: 0, withinBounds: true, resolved: true },
  );
  assert.equal(evaluateExceptionRemediation({
    affectedAmountMinor: 10_000,
    replacementCoveredAmountMinor: 4_001,
    refundedAmountMinor: 6_000,
  }).withinBounds, false);

  const valid = evaluateRefundCorrection({
    affectedAmountMinor: 10_000,
    replacementCoveredAmountMinor: 3_000,
    refundedAmountMinor: 7_000,
    originalRefundAmountMinor: 5_000,
    proposedRefundAmountMinor: 2_000,
  });
  assert.equal(valid.correctedRefundAmountMinor, 4_000);
  assert.equal(valid.withinBounds, true);
  assert.equal(valid.resolved, false);
  assert.equal(evaluateRefundCorrection({
    affectedAmountMinor: 10_000,
    replacementCoveredAmountMinor: 3_000,
    refundedAmountMinor: 1_000,
    originalRefundAmountMinor: 2_000,
    proposedRefundAmountMinor: 500,
  }).withinBounds, false);
  assert.equal(evaluateRefundCorrection({
    affectedAmountMinor: 10_000,
    replacementCoveredAmountMinor: 8_000,
    refundedAmountMinor: 4_000,
    originalRefundAmountMinor: 1_000,
    proposedRefundAmountMinor: 1_000,
  }).withinBounds, false);
});

let aliyunRuntime = true;
const { MySqlDialect } = require("drizzle-orm/mysql-core");
const { integer, sqliteTable } = require("drizzle-orm/sqlite-core");
const sharedPaymentRequests = sqliteTable("factory_payment_requests", {
  id: integer("id").notNull(),
});
const sharedInvoiceExceptions = sqliteTable("invoice_exceptions", {
  id: integer("id").notNull(),
});
const rowLockSource = fs.readFileSync(
  new URL("../database/runtime/row-lock.ts", import.meta.url),
  "utf8",
);
const rowLockModule = loadCommonJs(rowLockSource, specifier => {
  if (specifier === "drizzle-orm") return require("drizzle-orm");
  if (specifier === "@topology/shared-config/runtime-env") {
    return { isAliyunRuntime: () => aliyunRuntime };
  }
  if (specifier === "./schema") {
    return {
      factoryPaymentRequests: sharedPaymentRequests,
      invoiceExceptions: sharedInvoiceExceptions,
    };
  }
  return require(specifier);
});
const {
  buildInvoiceExceptionRowLock,
  buildPaymentRequestRowLock,
  withLockedFinancialRows,
  withLockedPaymentRequest,
} = rowLockModule;

test("MySQL lock builders emit primary-key SELECT FOR UPDATE", () => {
  const dialect = new MySqlDialect();
  for (const [query, table, id] of [
    [buildPaymentRequestRowLock(42), "factory_payment_requests", 42],
    [buildInvoiceExceptionRowLock(43), "invoice_exceptions", 43],
  ]) {
    const built = dialect.sqlToQuery(query);
    assert.match(built.sql, /^SELECT .* WHERE .* = \? FOR UPDATE$/i);
    assert.match(built.sql, new RegExp(table));
    assert.deepEqual(built.params, [id]);
  }
});

test("financial locks are deduplicated and ordered payment requests before exceptions", async () => {
  aliyunRuntime = true;
  const events = [];
  const dialect = new MySqlDialect();
  const db = {
    transaction: async callback => {
      events.push("transaction");
      return callback({
        execute: async query => {
          const built = dialect.sqlToQuery(query);
          const table = built.sql.includes("factory_payment_requests") ? "payment" : "exception";
          events.push(`${table}:${built.params[0]}`);
        },
      });
    },
  };
  await withLockedFinancialRows(db, {
    paymentRequestIds: [9, 3, 9],
    invoiceExceptionIds: [8, 2, 8],
  }, async () => events.push("work"));
  assert.deepEqual(events, [
    "transaction",
    "payment:3",
    "payment:9",
    "exception:2",
    "exception:8",
    "work",
  ]);
});

test("row-lock helper fails closed outside MySQL or without transaction support", async () => {
  aliyunRuntime = false;
  await assert.rejects(
    withLockedPaymentRequest({}, 7, async () => undefined),
    /只允许在RDS MySQL事务中/,
  );
  aliyunRuntime = true;
  await assert.rejects(
    withLockedPaymentRequest({}, 7, async () => undefined),
    /不支持事务/,
  );
  await assert.rejects(
    withLockedPaymentRequest({ transaction: async callback => callback({}) }, 7, async () => undefined),
    /不支持行锁/,
  );
});

test("all payable-ledger writers retain serialized SELECT FOR UPDATE protocol", () => {
  const finance = fs.readFileSync(new URL("../apps/api/src/modules/finance/writes.ts", import.meta.url), "utf8");
  const approvals = fs.readFileSync(new URL("../apps/api/src/modules/approvals/writes.ts", import.meta.url), "utf8");
  const payment = finance.slice(finance.indexOf('if (action === "record_payment")'), finance.indexOf('if (action === "record_refund")'));
  const refund = finance.slice(finance.indexOf('if (action === "record_refund")'), finance.indexOf('if (action === "request_record_correction")'));
  const replacement = finance.slice(finance.indexOf('if (action === "link_replacement_invoice")'), finance.indexOf('if (action === "record_payment")'));
  const correction = approvals.slice(approvals.indexOf('effect(context, "financial_record_correction"'));

  assert.match(payment, /factory_payment_requests WHERE id = \? LIMIT 1 FOR UPDATE/);
  assert.match(payment, /payment_records WHERE payment_request_id = \? ORDER BY id ASC FOR UPDATE/);
  assert.match(refund, /factory_payment_requests WHERE id = \? LIMIT 1 FOR UPDATE/);
  assert.match(refund, /invoice_exceptions e[\s\S]*WHERE e\.id = \? LIMIT 1 FOR UPDATE/);
  assert.match(refund, /payment_records WHERE payment_request_id = \? ORDER BY id ASC FOR UPDATE/);
  assert.match(replacement, /WHERE e\.id = \? LIMIT 1 FOR UPDATE/);
  assert.ok(replacement.indexOf("Replacement coverage exceeds") < replacement.indexOf("INSERT INTO replacement_invoice_links"));
  assert.match(correction, /payment_records WHERE id = \? LIMIT 1 FOR UPDATE/);
  assert.match(correction, /factory_payment_requests WHERE id = \? LIMIT 1 FOR UPDATE/);
  assert.ok(correction.indexOf("already corrected") < correction.indexOf("INSERT INTO payment_records"));
  assert.ok(correction.indexOf("INSERT INTO payment_records") < correction.indexOf("Correction would violate the payable ledger"));
});

test("record payment locks, validates step-up, writes and recomputes in order", () => {
  const handler = fs.readFileSync(new URL("../apps/api/src/modules/finance/writes.ts", import.meta.url), "utf8");
  const section = handler.slice(handler.indexOf('if (action === "record_payment")'), handler.indexOf('if (action === "record_refund")'));
  const ordered = [
    "FROM factory_payment_requests WHERE id = ? LIMIT 1 FOR UPDATE",
    "await stepUp(command",
    "objectVersion: objectVersion(paymentRequest)",
    "FROM payment_records WHERE payment_request_id = ? ORDER BY id ASC FOR UPDATE",
    "const net = payableNet",
    "if (net + amount",
    "INSERT INTO payment_records",
    "const newNet = net + amount",
    "UPDATE factory_payment_requests",
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = section.indexOf(marker);
    assert.ok(next > cursor, `${marker} must follow the preceding guarded step`);
    cursor = next;
  }
  assert.match(section, /\["generated", "submitted_to_finance", "partially_paid"\][\s\S]*includes\(String\(paymentRequest\.status\)\)/);
});

test("correction requests and finance UI share the payable classification", () => {
  const financeRoute = fs.readFileSync(new URL("../apps/api/src/modules/finance/writes.ts", import.meta.url), "utf8");
  const financeUi = fs.readFileSync(new URL("../apps/web/app/components/FinanceWorkspace.tsx", import.meta.url), "utf8");
  const requestSection = financeRoute.slice(
    financeRoute.indexOf('if (action === "request_record_correction")'),
    financeRoute.indexOf('requireRole(command.access, ["admin", "supply_chain_lead"])'),
  );
  assert.match(requestSection, /\["payment", "refund"\][\s\S]*includes\(String\(original\.recordType\)\)/);
  assert.match(financeUi, /import \{ isPayableLedgerRecord \}/);
  assert.match(financeUi, /data\.payments\.filter\(isPayableLedgerRecord\)/);
  assert.doesNotMatch(financeUi, /row\.recordType === "payment"/);
});
