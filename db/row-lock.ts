import { sql, type SQL } from "drizzle-orm";
import { isAliyunRuntime } from "../app/lib/runtime-env";
import { approvalRequests, factoryPaymentRequests, invoiceExceptions, paymentRecords } from "./schema";

type TransactionCapable<TDb> = TDb & {
  transaction?: <T>(callback: (tx: TDb) => Promise<T>) => Promise<T>;
};

type SqlExecutor = {
  execute?: (query: SQL) => PromiseLike<unknown>;
};

export function buildPaymentRequestRowLock(paymentRequestId: number) {
  if (!Number.isSafeInteger(paymentRequestId) || paymentRequestId <= 0) {
    throw new Error("请款单ID不合法。");
  }
  return sql`SELECT ${factoryPaymentRequests.id} FROM ${factoryPaymentRequests} WHERE ${factoryPaymentRequests.id} = ${paymentRequestId} FOR UPDATE`;
}

export function buildInvoiceExceptionRowLock(invoiceExceptionId: number) {
  if (!Number.isSafeInteger(invoiceExceptionId) || invoiceExceptionId <= 0) {
    throw new Error("发票异常单ID不合法。");
  }
  return sql`SELECT ${invoiceExceptions.id} FROM ${invoiceExceptions} WHERE ${invoiceExceptions.id} = ${invoiceExceptionId} FOR UPDATE`;
}

export function buildApprovalRequestRowLock(approvalRequestId: number) {
  if (!Number.isSafeInteger(approvalRequestId) || approvalRequestId <= 0) {
    throw new Error("审批单ID不合法。");
  }
  return sql`SELECT ${approvalRequests.id} FROM ${approvalRequests} WHERE ${approvalRequests.id} = ${approvalRequestId} FOR UPDATE`;
}

export function buildPaymentRecordRowLock(paymentRecordId: number) {
  if (!Number.isSafeInteger(paymentRecordId) || paymentRecordId <= 0) {
    throw new Error("付款记录ID不合法。");
  }
  return sql`SELECT ${paymentRecords.id} FROM ${paymentRecords} WHERE ${paymentRecords.id} = ${paymentRecordId} FOR UPDATE`;
}

async function executeRowLock<TDb>(db: TDb, query: SQL, message: string): Promise<void> {
  const executor = db as SqlExecutor;
  if (typeof executor.execute !== "function") throw new Error(message);
  await executor.execute(query);
}

export function lockApprovalRequestRow<TDb>(db: TDb, approvalRequestId: number) {
  return executeRowLock(db, buildApprovalRequestRowLock(approvalRequestId), "RDS事务不支持审批行锁。");
}

export function lockPaymentRecordRow<TDb>(db: TDb, paymentRecordId: number) {
  return executeRowLock(db, buildPaymentRecordRowLock(paymentRecordId), "RDS事务不支持付款记录行锁。");
}

function normalizeLockIds(ids: number[], message: string) {
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error(message);
  return Array.from(new Set(ids)).sort((left, right) => left - right);
}

export function normalizePaymentRequestLockIds(paymentRequestIds: number[]) {
  if (!paymentRequestIds.length) throw new Error("请款单ID不合法。");
  return normalizeLockIds(paymentRequestIds, "请款单ID不合法。");
}

export function normalizeInvoiceExceptionLockIds(invoiceExceptionIds: number[]) {
  if (!invoiceExceptionIds.length) throw new Error("发票异常单ID不合法。");
  return normalizeLockIds(invoiceExceptionIds, "发票异常单ID不合法。");
}

type FinancialLockInput = {
  paymentRequestIds?: number[];
  invoiceExceptionIds?: number[];
};

export async function withLockedFinancialRows<TDb, TResult>(
  db: TDb,
  input: FinancialLockInput,
  work: (tx: TDb) => Promise<TResult>,
) {
  const paymentRequestIds = normalizeLockIds(input.paymentRequestIds ?? [], "请款单ID不合法。");
  const invoiceExceptionIds = normalizeLockIds(input.invoiceExceptionIds ?? [], "发票异常单ID不合法。");
  if (!paymentRequestIds.length && !invoiceExceptionIds.length) {
    throw new Error("财务行锁目标不能为空。");
  }
  if (!isAliyunRuntime()) {
    throw new Error("真实财务账本写入只允许在RDS MySQL事务中执行。");
  }

  const capable = db as TransactionCapable<TDb>;
  if (typeof capable.transaction !== "function") {
    throw new Error("RDS数据库驱动不支持事务，已拒绝付款登记。");
  }

  return capable.transaction(async tx => {
    const executor = tx as SqlExecutor;
    if (typeof executor.execute !== "function") {
      throw new Error("RDS事务不支持行锁，已拒绝付款登记。");
    }
    for (const paymentRequestId of paymentRequestIds) {
      await executor.execute(buildPaymentRequestRowLock(paymentRequestId));
    }
    for (const invoiceExceptionId of invoiceExceptionIds) {
      await executor.execute(buildInvoiceExceptionRowLock(invoiceExceptionId));
    }
    return work(tx);
  });
}

export function withLockedPaymentRequests<TDb, TResult>(
  db: TDb,
  paymentRequestIds: number[],
  work: (tx: TDb) => Promise<TResult>,
) {
  return withLockedFinancialRows(db, { paymentRequestIds: normalizePaymentRequestLockIds(paymentRequestIds) }, work);
}

export function withLockedPaymentRequest<TDb, TResult>(
  db: TDb,
  paymentRequestId: number,
  work: (tx: TDb) => Promise<TResult>,
) {
  return withLockedPaymentRequests(db, [paymentRequestId], work);
}

export function withLockedInvoiceExceptions<TDb, TResult>(
  db: TDb,
  invoiceExceptionIds: number[],
  work: (tx: TDb) => Promise<TResult>,
) {
  return withLockedFinancialRows(db, { invoiceExceptionIds: normalizeInvoiceExceptionLockIds(invoiceExceptionIds) }, work);
}

export function withLockedInvoiceException<TDb, TResult>(
  db: TDb,
  invoiceExceptionId: number,
  work: (tx: TDb) => Promise<TResult>,
) {
  return withLockedInvoiceExceptions(db, [invoiceExceptionId], work);
}
