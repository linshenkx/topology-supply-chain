export type PaymentLedgerRecord = {
  amountMinor: number;
  recordType: string;
  invoiceExceptionId: number | null;
};

type PaymentLedgerInput = {
  totalAmountMinor: number;
  ledgerRecords: PaymentLedgerRecord[];
};

type PaymentCapacityInput = PaymentLedgerInput & {
  incomingAmountMinor: number;
};

function assertMoney(value: number, message: string, allowNegative = false) {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(message);
  }
}

export function isPayableLedgerRecord(record: PaymentLedgerRecord) {
  if (!Number.isSafeInteger(record.amountMinor)
    || (record.recordType === "reversal" ? record.amountMinor >= 0 : record.amountMinor <= 0)) {
    throw new Error("付款账本金额不合法。");
  }
  if (record.invoiceExceptionId !== null
    && (!Number.isSafeInteger(record.invoiceExceptionId) || record.invoiceExceptionId <= 0)) {
    throw new Error("付款账本关联异常单不合法。");
  }
  if (record.recordType === "payment") {
    if (record.invoiceExceptionId !== null) throw new Error("原始付款不能关联退款异常单。");
    return true;
  }
  if (record.recordType === "refund") {
    if (record.invoiceExceptionId === null) throw new Error("原始退款缺少关联异常单。");
    return false;
  }
  if (["correction", "reversal"].includes(record.recordType)) {
    return record.invoiceExceptionId === null;
  }
  throw new Error("付款账本记录类型不合法。");
}

export function evaluatePayableLedger(input: PaymentLedgerInput) {
  if (!Number.isSafeInteger(input.totalAmountMinor) || input.totalAmountMinor < 0) {
    throw new Error("请款金额不合法。");
  }
  let netPaidAmountMinor = 0;
  for (const record of input.ledgerRecords) {
    if (!isPayableLedgerRecord(record)) continue;
    netPaidAmountMinor += record.amountMinor;
    if (!Number.isSafeInteger(netPaidAmountMinor)) {
      throw new Error("付款账本金额超出安全计算范围。");
    }
  }
  return {
    netPaidAmountMinor,
    remainingAmountMinor: Math.max(0, input.totalAmountMinor - netPaidAmountMinor),
    withinBounds: netPaidAmountMinor >= 0 && netPaidAmountMinor <= input.totalAmountMinor,
  };
}

export function evaluatePaymentCapacity(input: PaymentCapacityInput) {
  if (!Number.isSafeInteger(input.incomingAmountMinor) || input.incomingAmountMinor <= 0) {
    throw new Error("付款金额不合法。");
  }
  const ledger = evaluatePayableLedger(input);
  const totalPaidAmountMinor = ledger.netPaidAmountMinor + input.incomingAmountMinor;
  if (!Number.isSafeInteger(totalPaidAmountMinor)) {
    throw new Error("付款账本金额超出安全计算范围。");
  }

  return {
    paidAmountMinor: ledger.netPaidAmountMinor,
    totalPaidAmountMinor,
    remainingAmountMinor: Math.max(0, input.totalAmountMinor - totalPaidAmountMinor),
    wouldExceed: totalPaidAmountMinor > input.totalAmountMinor,
    ledgerWithinBounds: ledger.withinBounds,
  };
}

type RefundCorrectionInput = {
  affectedAmountMinor: number;
  replacementCoveredAmountMinor: number;
  refundedAmountMinor: number;
  originalRefundAmountMinor: number;
  proposedRefundAmountMinor: number;
};

type ExceptionRemediationInput = {
  affectedAmountMinor: number;
  replacementCoveredAmountMinor: number;
  refundedAmountMinor: number;
};

export function evaluateExceptionRemediation(input: ExceptionRemediationInput) {
  assertMoney(input.affectedAmountMinor, "异常影响金额不合法。");
  assertMoney(input.replacementCoveredAmountMinor, "已补票金额不合法。");
  assertMoney(input.refundedAmountMinor, "已退款金额不合法。");
  const remediatedAmountMinor = input.replacementCoveredAmountMinor + input.refundedAmountMinor;
  const withinBounds = Number.isSafeInteger(remediatedAmountMinor)
    && remediatedAmountMinor <= input.affectedAmountMinor;
  return {
    remediatedAmountMinor,
    remainingAmountMinor: withinBounds ? input.affectedAmountMinor - remediatedAmountMinor : 0,
    withinBounds,
    resolved: withinBounds && remediatedAmountMinor === input.affectedAmountMinor,
  };
}

export function evaluateRefundCorrection(input: RefundCorrectionInput) {
  for (const [value, message] of [
    [input.affectedAmountMinor, "异常影响金额不合法。"],
    [input.replacementCoveredAmountMinor, "已补票金额不合法。"],
    [input.refundedAmountMinor, "已退款金额不合法。"],
    [input.originalRefundAmountMinor, "原退款金额不合法。"],
    [input.proposedRefundAmountMinor, "更正后退款金额不合法。"],
  ] as const) {
    assertMoney(value, message);
  }
  const correctedRefundAmountMinor = input.refundedAmountMinor
    - input.originalRefundAmountMinor
    + input.proposedRefundAmountMinor;
  const remediation = correctedRefundAmountMinor >= 0 && Number.isSafeInteger(correctedRefundAmountMinor)
    ? evaluateExceptionRemediation({
      affectedAmountMinor: input.affectedAmountMinor,
      replacementCoveredAmountMinor: input.replacementCoveredAmountMinor,
      refundedAmountMinor: correctedRefundAmountMinor,
    })
    : { remediatedAmountMinor: Number.NaN, withinBounds: false, resolved: false };
  return {
    correctedRefundAmountMinor,
    remediatedAmountMinor: remediation.remediatedAmountMinor,
    withinBounds: remediation.withinBounds,
    resolved: remediation.resolved,
  };
}
