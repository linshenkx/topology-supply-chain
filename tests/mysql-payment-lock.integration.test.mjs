import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { and, eq, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { int, mysqlTable, serial, varchar } from "drizzle-orm/mysql-core";
import mysql from "mysql2/promise";
import ts from "typescript";

const require = createRequire(import.meta.url);
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

function loadCommonJs(source, requireModule = require) {
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
    Math,
    Number,
  });
  return testModule.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function observeLockAttempt(db, onAttempt) {
  return {
    transaction: callback => db.transaction(tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property === "execute") {
          return async (...args) => {
            onAttempt();
            return target.execute(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }))),
  };
}

test("MySQL row lock serializes competing payments and exposes the committed ledger", {
  skip: !testDatabaseUrl && "set TEST_DATABASE_URL to run the MySQL integration test",
  timeout: 20_000,
}, async t => {
  const suffix = `${process.pid}_${Date.now()}`;
  const requestTableName = `it_payment_requests_${suffix}`;
  const recordTableName = `it_payment_records_${suffix}`;
  const paymentRequests = mysqlTable(requestTableName, {
    id: serial("id").primaryKey(),
    totalAmountMinor: int("total_amount_minor").notNull(),
  });
  const paymentRecords = mysqlTable(recordTableName, {
    id: serial("id").primaryKey(),
    paymentRequestId: int("payment_request_id").notNull(),
    amountMinor: int("amount_minor").notNull(),
    bankReference: varchar("bank_reference", { length: 64 }).notNull(),
  });
  const invoiceExceptions = mysqlTable(`it_invoice_exceptions_${suffix}`, {
    id: serial("id").primaryKey(),
  });

  const setupConnection = await mysql.createConnection(testDatabaseUrl);
  const firstConnection = await mysql.createConnection(testDatabaseUrl);
  const secondConnection = await mysql.createConnection(testDatabaseUrl);
  const observerConnection = await mysql.createConnection(testDatabaseUrl);

  await Promise.all([
    firstConnection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"),
    secondConnection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"),
  ]);
  const [[firstIsolation]] = await firstConnection.query("SELECT @@transaction_isolation AS isolationLevel");
  const [[secondIsolation]] = await secondConnection.query("SELECT @@transaction_isolation AS isolationLevel");
  assert.equal(firstIsolation.isolationLevel, "REPEATABLE-READ");
  assert.equal(secondIsolation.isolationLevel, "REPEATABLE-READ");

  t.after(async () => {
    await setupConnection.query(`DROP TABLE IF EXISTS \`${recordTableName}\``);
    await setupConnection.query(`DROP TABLE IF EXISTS \`${requestTableName}\``);
    await Promise.allSettled([
      firstConnection.end(),
      secondConnection.end(),
      observerConnection.end(),
      setupConnection.end(),
    ]);
  });

  await setupConnection.query(`
    CREATE TABLE \`${requestTableName}\` (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      total_amount_minor INT NOT NULL
    ) ENGINE=InnoDB
  `);
  await setupConnection.query(`
    CREATE TABLE \`${recordTableName}\` (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      payment_request_id INT NOT NULL,
      amount_minor INT NOT NULL,
      bank_reference VARCHAR(64) NOT NULL,
      INDEX payment_request_id_idx (payment_request_id)
    ) ENGINE=InnoDB
  `);

  const setupDb = drizzle({ client: setupConnection });
  const [parentRequest] = await setupDb.insert(paymentRequests)
    .values({ totalAmountMinor: 100 })
    .$returningId();
  assert.ok(parentRequest?.id);

  const rowLockSource = fs.readFileSync(
    new URL("../database/runtime/row-lock.ts", import.meta.url),
    "utf8",
  );
  const { withLockedPaymentRequest } = loadCommonJs(rowLockSource, specifier => {
    if (specifier === "drizzle-orm") return require("drizzle-orm");
    if (specifier === "@topology/shared-config/runtime-env") {
      return { isAliyunRuntime: () => true };
    }
    if (specifier === "./schema") {
      return { factoryPaymentRequests: paymentRequests, invoiceExceptions };
    }
    return require(specifier);
  });

  const firstLockAttempted = deferred();
  const firstEnteredWork = deferred();
  const releaseFirst = deferred();
  const secondLockAttempted = deferred();
  const secondEnteredWork = deferred();
  const firstDb = observeLockAttempt(
    drizzle({ client: firstConnection }),
    () => firstLockAttempted.resolve(),
  );
  const secondDb = observeLockAttempt(
    drizzle({ client: secondConnection }),
    () => secondLockAttempted.resolve(),
  );

  async function attemptPayment(db, bankReference, beforeInsert) {
    return withLockedPaymentRequest(db, parentRequest.id, async tx => {
      const [requestRow] = await tx.select({
        totalAmountMinor: paymentRequests.totalAmountMinor,
      }).from(paymentRequests).where(eq(paymentRequests.id, parentRequest.id));
      const [ledger] = await tx.select({
        paidAmountMinor: sum(paymentRecords.amountMinor),
      }).from(paymentRecords).where(and(
        eq(paymentRecords.paymentRequestId, parentRequest.id),
        sql`${paymentRecords.amountMinor} > 0`,
      ));
      const paidAmountMinor = Number(ledger?.paidAmountMinor ?? 0);
      await beforeInsert(paidAmountMinor);
      if (paidAmountMinor + 60 > requestRow.totalAmountMinor) {
        throw new Error(`overpayment after locked refresh: ${paidAmountMinor} + 60 > ${requestRow.totalAmountMinor}`);
      }
      await tx.insert(paymentRecords).values({
        paymentRequestId: parentRequest.id,
        amountMinor: 60,
        bankReference,
      });
      return { paidAmountMinorBeforeInsert: paidAmountMinor };
    });
  }

  const first = attemptPayment(firstDb, "LOCK-1", async paidAmountMinor => {
    assert.equal(paidAmountMinor, 0);
    firstEnteredWork.resolve();
    await releaseFirst.promise;
  });
  await firstLockAttempted.promise;
  await firstEnteredWork.promise;

  const secondStartedAt = Date.now();
  const second = attemptPayment(secondDb, "LOCK-2", async paidAmountMinor => {
    secondEnteredWork.resolve({ paidAmountMinor, enteredAt: Date.now() });
  });
  await secondLockAttempted.promise;

  const blockedState = await Promise.race([
    secondEnteredWork.promise.then(() => "entered"),
    delay(250, "waiting"),
  ]);
  assert.equal(blockedState, "waiting", "second transaction must wait for the first row lock");

  releaseFirst.resolve();
  const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);
  assert.equal(firstOutcome.status, "fulfilled");
  assert.equal(firstOutcome.value.paidAmountMinorBeforeInsert, 0);
  assert.equal(secondOutcome.status, "rejected");
  assert.match(secondOutcome.reason.message, /overpayment after locked refresh: 60 \+ 60 > 100/);

  const secondObservation = await secondEnteredWork.promise;
  assert.equal(secondObservation.paidAmountMinor, 60, "second transaction must see the first committed payment");
  assert.ok(
    secondObservation.enteredAt - secondStartedAt >= 200,
    "second transaction should enter its work only after waiting on the row lock",
  );

  const observerDb = drizzle({ client: observerConnection });
  const [finalLedger] = await observerDb.select({
    count: sql`COUNT(*)`,
    totalAmountMinor: sum(paymentRecords.amountMinor),
  }).from(paymentRecords).where(eq(paymentRecords.paymentRequestId, parentRequest.id));
  assert.equal(Number(finalLedger.count), 1);
  assert.equal(Number(finalLedger.totalAmountMinor), 60);
});
