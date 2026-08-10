import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  approvalRequests,
  factoryInvoices,
  factoryPaymentRequestItems,
  factoryPaymentRequests,
  invoiceExceptions,
  invoicePaymentAllocations,
  invoiceVerifications,
  paymentRecords,
  purchaseOrders,
  replacementInvoiceLinks,
  users,
} from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { withLockedFinancialRows, withLockedInvoiceException, withLockedPaymentRequest } from "../../../db/row-lock";
import { withDbTransaction } from "../../../db/transaction";
import {
  AccessError,
  accessErrorResponse,
  requireAccess,
  requireRole,
} from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { evaluateExceptionRemediation, evaluatePayableLedger, evaluatePaymentCapacity } from "../../lib/payment-guard";
import { createReminder } from "../../lib/reminders";
import { consumeVerifiedStepUp } from "../../lib/step-up";

const REJECTION_REASONS = new Set([
  "amount_mismatch",
  "title_error",
  "tax_number_error",
  "tax_rate_error",
  "duplicate_invoice",
  "other",
]);

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "finance"]);
    if (access.localPreview) {
      return Response.json({ invoices: [], paymentRequests: [], payments: [], verifications: [], allocations: [], exceptions: [], replacementLinks: [], requestItems: [], purchaseOrders: [], preview: true });
    }
    const db = getDb();
    const [invoices, paymentRequests, payments, verifications, allocations, exceptions, replacementLinks, requestItems, orders] = await Promise.all([
      db.select().from(factoryInvoices).orderBy(desc(factoryInvoices.createdAt)).limit(200),
      db.select().from(factoryPaymentRequests).orderBy(desc(factoryPaymentRequests.createdAt)).limit(200),
      db.select().from(paymentRecords).orderBy(desc(paymentRecords.createdAt)).limit(300),
      db.select().from(invoiceVerifications).orderBy(desc(invoiceVerifications.verifiedAt)).limit(400),
      db.select().from(invoicePaymentAllocations).orderBy(desc(invoicePaymentAllocations.createdAt)).limit(400),
      db.select().from(invoiceExceptions).orderBy(desc(invoiceExceptions.createdAt)).limit(200),
      db.select().from(replacementInvoiceLinks).orderBy(desc(replacementInvoiceLinks.createdAt)).limit(400),
      db.select().from(factoryPaymentRequestItems).orderBy(desc(factoryPaymentRequestItems.id)).limit(500),
      db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)).limit(300),
    ]);
    await writeAudit(access, {
      action: "view",
      module: "finance",
      entityType: "finance_dashboard",
      entityId: "latest",
      sensitiveView: true,
      request,
    });
    return Response.json({ invoices, paymentRequests, payments, verifications, allocations, exceptions, replacementLinks, requestItems, purchaseOrders: orders });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "create_invoice") return createInvoice(request, access, body);
    if (body.action === "verify_invoice") return verifyInvoice(request, access, body);
    if (body.action === "record_payment") return recordPayment(request, access, body);
    if (body.action === "invalidate_invoice") return invalidateInvoice(request, access, body);
    if (body.action === "link_replacement_invoice") return linkReplacementInvoice(request, access, body);
    if (body.action === "record_refund") return recordRefund(request, access, body);
    if (body.action === "request_record_correction") return requestRecordCorrection(request, access, body);
    if (body.action === "release_invoice_risk") return releaseInvoiceRisk(request, access, body);
    return Response.json({ error: "不支持的财务操作。" }, { status: 400 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

async function releaseInvoiceRisk(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "supply_chain_lead"]);
  const invoiceExceptionId = Number(body.invoiceExceptionId);
  const reason = String(body.reason ?? "").trim();
  const evidenceFileKey = String(body.evidenceFileKey ?? "").trim();
  if (!invoiceExceptionId || !reason || !evidenceFileKey) {
    return Response.json({ error: "预警异常、解除原因和证明材料不能为空。" }, { status: 400 });
  }
  const challengeNo = body.challengeNo;
  const stepUpScope = `finance:release_invoice_risk:${invoiceExceptionId}`;
  if (access.localPreview) {
    await consumeVerifiedStepUp(null, { challengeNo, userId: access.userId, localPreview: true, scope: stepUpScope });
    return Response.json({ success: true, preview: true });
  }
  const db = getDb();
  const [exception] = await db.select().from(invoiceExceptions).where(eq(invoiceExceptions.id, invoiceExceptionId)).limit(1);
  if (!exception || exception.status !== "risk_warning") {
    return Response.json({ error: "该异常当前不是可解除的工厂风险预警。" }, { status: 409 });
  }
  const now = new Date().toISOString();
  await withDbTransaction(db, async tx => {
    await consumeVerifiedStepUp(tx, { challengeNo, userId: access.userId, localPreview: false, scope: stepUpScope });
    await tx.update(invoiceExceptions).set({
      status: "awaiting_remediation",
      riskReleasedBy: access.userId,
      riskReleasedAt: now,
      riskReleaseReason: reason,
      riskReleaseEvidenceFileKey: evidenceFileKey,
      updatedAt: now,
    }).where(eq(invoiceExceptions.id, invoiceExceptionId));
  });
  await writeAudit(access, {
    action: "release_warning",
    module: "finance",
    entityType: "invoice_exception",
    entityId: invoiceExceptionId,
    before: exception,
    after: { reason, evidenceFileKey },
    sensitiveView: true,
    request,
  });
  return Response.json({ success: true });
}

async function invalidateInvoice(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "finance"]);
  const invoiceId = Number(body.invoiceId);
  const exceptionType = String(body.exceptionType);
  const replacementDeadline = String(body.replacementDeadline ?? "");
  const reason = String(body.reason ?? "").trim();
  if (!invoiceId || !["red_invoice", "voided"].includes(exceptionType) || !replacementDeadline || !reason) {
    return Response.json({ error: "发票、异常类型、补票截止日期和原因不能为空。" }, { status: 400 });
  }
  if (Date.parse(`${replacementDeadline}T23:59:59+08:00`) <= Date.now()) {
    return Response.json({ error: "补票截止日期必须晚于当前日期。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ exception: { id: 0 }, preview: true }, { status: 201 });
  const db = getDb();
  const [invoice] = await db.select().from(factoryInvoices).where(eq(factoryInvoices.id, invoiceId)).limit(1);
  if (!invoice) return Response.json({ error: "发票不存在。" }, { status: 404 });
  const active = await db.select().from(invoiceExceptions).where(eq(invoiceExceptions.invoiceId, invoiceId)).limit(1);
  if (active.length && active[0].status !== "resolved") {
    return Response.json({ error: "该发票已有未关闭的补票或退款异常。" }, { status: 409 });
  }
  const allocations = await db.select().from(invoicePaymentAllocations).where(and(
    eq(invoicePaymentAllocations.invoiceId, invoiceId),
    eq(invoicePaymentAllocations.status, "active"),
  ));
  for (const allocation of allocations) {
    await db.update(invoicePaymentAllocations).set({ status: "frozen", updatedAt: new Date().toISOString() }).where(eq(invoicePaymentAllocations.id, allocation.id));
    await db.update(factoryPaymentRequests).set({
      invoiceCoveredAmountMinor: sql`MAX(0, ${factoryPaymentRequests.invoiceCoveredAmountMinor} - ${allocation.allocatedAmountMinor})`,
      status: "invoice_exception_frozen",
      updatedAt: new Date().toISOString(),
    }).where(eq(factoryPaymentRequests.id, allocation.paymentRequestId));
  }
  await db.update(factoryInvoices).set({ status: "invalidated", updatedAt: new Date().toISOString() }).where(eq(factoryInvoices.id, invoiceId));
  const invoiceException = await insertOne<typeof invoiceExceptions.$inferSelect>(db.insert(invoiceExceptions).values({
    invoiceId,
    exceptionType: exceptionType as "red_invoice" | "voided",
    affectedAmountMinor: invoice.amountTaxIncludedMinor,
    replacementDeadline,
    reason,
    createdBy: access.userId,
  }), id => db.select().from(invoiceExceptions).where(eq(invoiceExceptions.id, id)).limit(1));
  const factoryUsers = await db.select({ id: users.id }).from(users).where(eq(users.factoryId, invoice.factoryId));
  await createReminder({
    reminderType: "invoice_replacement_overdue",
    entityType: "invoice_exception",
    entityId: invoiceException.id,
    businessNo: invoice.invoiceNo,
    dueAt: `${replacementDeadline}T23:59:59+08:00`,
    nextRunAt: `${replacementDeadline}T23:59:59+08:00`,
    recurrence: "daily_overdue",
    recipientRoles: ["supply_chain", "finance"],
    recipientUserIds: factoryUsers.map((row) => row.id),
    severity: "red",
  });
  await writeAudit(access, { action: "invalidate", module: "finance", entityType: "invoice", entityId: invoice.id, businessNo: invoice.invoiceNo, before: invoice, after: invoiceException, sensitiveView: true, request });
  return Response.json({ exception: invoiceException, frozenPaymentRequestCount: allocations.length }, { status: 201 });
}

async function linkReplacementInvoice(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "finance", "supply_chain"]);
  const invoiceExceptionId = Number(body.invoiceExceptionId);
  const replacementInvoiceId = Number(body.replacementInvoiceId);
  const coveredAmountMinor = Math.trunc(Number(body.coveredAmountMinor));
  if (!invoiceExceptionId || !replacementInvoiceId || coveredAmountMinor <= 0) {
    return Response.json({ error: "补票异常、新发票和补票金额不能为空。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ link: { id: 0 }, preview: true }, { status: 201 });
  const db = getDb();
  const result = await withLockedInvoiceException(db, invoiceExceptionId, async tx => {
    const [exception] = await tx.select().from(invoiceExceptions).where(eq(invoiceExceptions.id, invoiceExceptionId)).limit(1);
    const [replacement] = await tx.select().from(factoryInvoices).where(eq(factoryInvoices.id, replacementInvoiceId)).limit(1);
    if (!exception || !replacement) throw new AccessError(404, "补票异常或新发票不存在。");
    if (exception.status === "resolved") throw new AccessError(409, "该异常已经关闭。");
    if (replacement.status !== "verified") {
      throw new AccessError(409, "补开的新发票必须经过供应链和财务重新双重核验。");
    }
    if (coveredAmountMinor > replacement.amountTaxIncludedMinor) {
      throw new AccessError(409, "补票金额超过新发票金额。");
    }
    const replacementTotal = exception.replacementCoveredAmountMinor + coveredAmountMinor;
    const remediation = evaluateExceptionRemediation({
      affectedAmountMinor: exception.affectedAmountMinor,
      replacementCoveredAmountMinor: replacementTotal,
      refundedAmountMinor: exception.refundedAmountMinor,
    });
    if (!remediation.withinBounds) {
      throw new AccessError(409, "补票金额超过异常待处理金额。");
    }
    const created = await insertOne<typeof replacementInvoiceLinks.$inferSelect>(tx.insert(replacementInvoiceLinks).values({
      invoiceExceptionId,
      replacementInvoiceId,
      coveredAmountMinor,
      status: "verified",
    }), id => tx.select().from(replacementInvoiceLinks).where(eq(replacementInvoiceLinks.id, id)).limit(1));
    await tx.update(invoiceExceptions).set({
      replacementCoveredAmountMinor: replacementTotal,
      status: remediation.resolved ? "resolved" : exception.status,
      resolvedAt: remediation.resolved ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(invoiceExceptions.id, invoiceExceptionId));
    return { link: created, resolved: remediation.resolved };
  });
  await writeAudit(access, { action: "link_replacement", module: "finance", entityType: "invoice_exception", entityId: invoiceExceptionId, after: result.link, sensitiveView: true, request });
  return Response.json(result, { status: 201 });
}

async function recordRefund(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "finance"]);
  const invoiceExceptionId = Number(body.invoiceExceptionId);
  const paymentRequestId = Number(body.paymentRequestId);
  const amountMinor = Math.trunc(Number(body.amountMinor));
  const paidAt = String(body.receivedAt ?? "");
  const bankReference = String(body.bankReference ?? "").trim();
  if (!invoiceExceptionId || !paymentRequestId || amountMinor <= 0 || !paidAt || !bankReference) {
    return Response.json({ error: "异常单、原请款单、退款金额、到账日期和银行流水号不能为空。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ refund: { id: 0 }, preview: true }, { status: 201 });
  const db = getDb();
  const result = await withLockedFinancialRows(db, {
    paymentRequestIds: [paymentRequestId],
    invoiceExceptionIds: [invoiceExceptionId],
  }, async tx => {
    const [paymentRequest] = await tx.select().from(factoryPaymentRequests).where(eq(factoryPaymentRequests.id, paymentRequestId)).limit(1);
    const [exception] = await tx.select().from(invoiceExceptions).where(eq(invoiceExceptions.id, invoiceExceptionId)).limit(1);
    if (!paymentRequest) throw new AccessError(404, "原请款单不存在。");
    if (!exception || exception.status === "resolved") {
      throw new AccessError(409, "补票退款异常不存在或已经关闭。");
    }
    const refundedTotal = exception.refundedAmountMinor + amountMinor;
    const remediation = evaluateExceptionRemediation({
      affectedAmountMinor: exception.affectedAmountMinor,
      replacementCoveredAmountMinor: exception.replacementCoveredAmountMinor,
      refundedAmountMinor: refundedTotal,
    });
    if (!remediation.withinBounds) {
      throw new AccessError(409, "退款金额超过异常待处理金额。");
    }
    const created = await insertOne<typeof paymentRecords.$inferSelect>(tx.insert(paymentRecords).values({
      paymentRequestId,
      amountMinor,
      paidAt,
      bankReference,
      recordType: "refund",
      invoiceExceptionId,
      recordedBy: access.userId,
    }), id => tx.select().from(paymentRecords).where(eq(paymentRecords.id, id)).limit(1));
    const payableLedger = await tx.select({
      amountMinor: paymentRecords.amountMinor,
      recordType: paymentRecords.recordType,
      invoiceExceptionId: paymentRecords.invoiceExceptionId,
    }).from(paymentRecords).where(eq(paymentRecords.paymentRequestId, paymentRequestId));
    const ledgerState = evaluatePayableLedger({
      totalAmountMinor: paymentRequest.totalAmountMinor,
      ledgerRecords: payableLedger,
    });
    if (!ledgerState.withinBounds) {
      throw new AccessError(409, "退款写入后请款单付款净额越界，已撤销本次退款。");
    }
    await tx.update(invoiceExceptions).set({
      refundedAmountMinor: refundedTotal,
      status: remediation.resolved ? "resolved" : exception.status,
      resolvedAt: remediation.resolved ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    }).where(eq(invoiceExceptions.id, invoiceExceptionId));
    return { refund: created, resolved: remediation.resolved, remainingAmountMinor: remediation.remainingAmountMinor };
  });
  await writeAudit(access, { action: "record_refund", module: "finance", entityType: "payment_record", entityId: result.refund.id, after: result.refund, sensitiveView: true, request });
  return Response.json(result, { status: 201 });
}

async function requestRecordCorrection(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "finance"]);
  const paymentRecordId = Number(body.paymentRecordId);
  const reason = String(body.reason ?? "").trim();
  const proposedPaymentRequestId = Number(body.proposedPaymentRequestId);
  const proposedAmountMinor = Math.trunc(Number(body.proposedAmountMinor));
  const proposedPaidAt = String(body.proposedPaidAt ?? "");
  const proposedBankReference = String(body.proposedBankReference ?? "").trim();
  if (!paymentRecordId || !reason || !proposedPaymentRequestId || proposedAmountMinor <= 0 || !proposedPaidAt || !proposedBankReference) {
    return Response.json({ error: "原记录、更正原因及更正后的请款单、金额、日期、流水号均不能为空。" }, { status: 400 });
  }
  const challengeNo = body.challengeNo;
  const stepUpScope = `finance:request_record_correction:${paymentRecordId}`;
  if (access.localPreview) {
    await consumeVerifiedStepUp(null, { challengeNo, userId: access.userId, localPreview: true, scope: stepUpScope });
    return Response.json({ approval: { id: 0 }, preview: true }, { status: 201 });
  }
  const db = getDb();
  const [original] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, paymentRecordId)).limit(1);
  if (!original) return Response.json({ error: "原付款或退款记录不存在。" }, { status: 404 });
  if (!(["payment", "refund"] as string[]).includes(original.recordType)) {
    return Response.json({ error: "只能更正原始付款或退款记录。" }, { status: 409 });
  }
  if ((original.recordType === "payment" && original.invoiceExceptionId !== null)
    || (original.recordType === "refund" && !original.invoiceExceptionId)) {
    return Response.json({ error: "原财务记录的付款/退款分类不一致。" }, { status: 409 });
  }
  const now = new Date().toISOString();
  const approval = await withDbTransaction(db, async tx => {
    await consumeVerifiedStepUp(tx, { challengeNo, userId: access.userId, localPreview: false, scope: stepUpScope });
    return insertOne<typeof approvalRequests.$inferSelect>(tx.insert(approvalRequests).values({
      requestNo: `AP-FINCORR-${Date.now()}`,
      workflowType: "financial_record_correction",
      entityType: "payment_record",
      entityId: original.id,
      summary: `更正财务记录 #${original.id}`,
      payloadJson: JSON.stringify({
        proposedPaymentRequestId,
        proposedAmountMinor,
        proposedPaidAt,
        proposedBankReference,
        originalRecordType: original.recordType,
        invoiceExceptionId: original.invoiceExceptionId,
        reason,
      }),
      highRisk: true,
      requestedBy: access.userId,
      smsVerifiedAt: now,
    }), id => tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1));
  });
  await writeAudit(access, { action: "request_correction", module: "finance", entityType: "payment_record", entityId: original.id, before: original, after: { approvalId: approval.id, reason }, sensitiveView: true, request });
  return Response.json({ approval }, { status: 201 });
}

async function createInvoice(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "supply_chain"]);
  const factoryId = Number(body.factoryId);
  const purchaseOrderId = Number(body.purchaseOrderId);
  const invoiceNo = String(body.invoiceNo ?? "").trim();
  const amount = Math.trunc(Number(body.amountTaxIncludedMinor));
  const taxAmount = Math.trunc(Number(body.taxAmountMinor));
  const issuedAt = String(body.issuedAt ?? "");
  const fileKey = String(body.fileKey ?? "").trim();
  const coverageMode = body.coverageMode === "delivery_batch" ? "delivery_batch" : "full_order";
  if (!factoryId || !purchaseOrderId || !invoiceNo || amount <= 0 || taxAmount < 0 || !issuedAt || !fileKey) {
    return Response.json({ error: "工厂、采购单、发票号码、金额、开票日期和发票文件均为必填项。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ invoice: { id: 0, invoiceNo }, preview: true }, { status: 201 });
  const db = getDb();
  const [order] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).limit(1);
  if (!order) return Response.json({ error: "采购单不存在。" }, { status: 404 });
  const expected = coverageMode === "full_order"
    ? order.totalTaxIncludedMinor
    : Math.trunc(Number(body.expectedAmountMinor));
  if (!expected || expected <= 0) {
    return Response.json({ error: "分批发票必须提供对应发货批次的应开票金额。" }, { status: 400 });
  }
  const invoice = await insertOne<typeof factoryInvoices.$inferSelect>(db.insert(factoryInvoices).values({
    factoryId,
    purchaseOrderId,
    coverageMode,
    deliveryBatchId: coverageMode === "delivery_batch" ? Number(body.deliveryBatchId) : null,
    invoiceNo,
    invoiceType: ["vat_special", "vat_general", "other"].includes(String(body.invoiceType))
      ? body.invoiceType as "vat_special" | "vat_general" | "other"
      : "vat_special",
    amountTaxIncludedMinor: amount,
    taxAmountMinor: taxAmount,
    issuedAt,
    receivedAt: String(body.receivedAt ?? "") || null,
    fileKey,
    status: "received",
    expectedAmountMinor: expected,
    amountMatchesExpected: amount === expected,
    mismatchAmountMinor: amount - expected,
    maintainedBy: access.userId,
  }), id => db.select().from(factoryInvoices).where(eq(factoryInvoices.id, id)).limit(1));
  await writeAudit(access, {
    action: "create",
    module: "finance",
    entityType: "invoice",
    entityId: invoice.id,
    businessNo: invoice.invoiceNo,
    after: invoice,
    request,
  });
  return Response.json({
    invoice,
    verificationBlocked: !invoice.amountMatchesExpected,
    warning: !invoice.amountMatchesExpected ? "发票金额与应开票金额不一致，已禁止核验。" : undefined,
  }, { status: 201 });
}

async function verifyInvoice(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "supply_chain", "finance"]);
  const invoiceId = Number(body.invoiceId);
  const verifierRole = String(body.verifierRole);
  const decision = String(body.decision);
  const rejectionReason = String(body.rejectionReason ?? "");
  if (!invoiceId || !["supply_chain", "finance"].includes(verifierRole) || !["approved", "rejected"].includes(decision)) {
    return Response.json({ error: "发票、核验岗位和核验结果不能为空。" }, { status: 400 });
  }
  if (!access.roles.includes("admin") && !access.roles.includes(verifierRole)) {
    return Response.json({ error: "不能代替其他岗位核验发票。" }, { status: 403 });
  }
  if (decision === "rejected" && !REJECTION_REASONS.has(rejectionReason)) {
    return Response.json({ error: "核验不通过时必须选择有效原因。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ success: true, preview: true });
  const db = getDb();
  const [invoice] = await db.select().from(factoryInvoices).where(eq(factoryInvoices.id, invoiceId)).limit(1);
  if (!invoice) return Response.json({ error: "发票不存在。" }, { status: 404 });
  if (!invoice.amountMatchesExpected && decision === "approved") {
    return Response.json({ error: "发票金额不一致，禁止核验通过。" }, { status: 409 });
  }
  const existing = await db.select().from(invoiceVerifications).where(eq(invoiceVerifications.invoiceId, invoiceId));
  if (existing.some((row) => row.verifierRole === verifierRole)) {
    return Response.json({ error: "该岗位已经核验过此发票。" }, { status: 409 });
  }
  if (existing.some((row) => row.verifiedBy === access.userId)) {
    return Response.json({ error: "同一个人不能同时完成供应链和财务双重核验。" }, { status: 409 });
  }
  const approvedRoles = new Set(
    [...existing, { verifierRole, decision }].filter((row) => row.decision === "approved").map((row) => row.verifierRole),
  );
  const fullyVerified = approvedRoles.has("supply_chain") && approvedRoles.has("finance");
  await withDbTransaction(db, async tx => {
    await tx.insert(invoiceVerifications).values({
      invoiceId,
      verifierRole: verifierRole as "supply_chain" | "finance",
      decision: decision as "approved" | "rejected",
      rejectionReason: decision === "rejected" ? rejectionReason : null,
      verifiedBy: access.userId,
    });
    if (decision === "rejected") {
      await tx.update(factoryInvoices).set({ status: "rejected", updatedAt: new Date().toISOString() }).where(eq(factoryInvoices.id, invoiceId));
      return;
    }
    if (fullyVerified) {
      await tx.update(factoryInvoices).set({ status: "verified", updatedAt: new Date().toISOString() }).where(eq(factoryInvoices.id, invoiceId));
      await allocateInvoice(tx, invoice, access.userId);
    }
  });
  await writeAudit(access, {
    action: "verify",
    module: "finance",
    entityType: "invoice",
    entityId: invoice.id,
    businessNo: invoice.invoiceNo,
    after: { verifierRole, decision, fullyVerified },
    request,
  });
  return Response.json({ success: true, fullyVerified });
}

async function allocateInvoice(db: ReturnType<typeof getDb>, invoice: typeof factoryInvoices.$inferSelect, userId: number) {
  const items = await db
    .select()
    .from(factoryPaymentRequestItems)
    .where(eq(factoryPaymentRequestItems.purchaseOrderId, invoice.purchaseOrderId))
    .orderBy(asc(factoryPaymentRequestItems.id));
  if (!items.length) return;
  const requestIds = Array.from(new Set(items.map((item) => item.paymentRequestId)));
  const requests = await db
    .select()
    .from(factoryPaymentRequests)
    .where(inArray(factoryPaymentRequests.id, requestIds));
  let remaining = invoice.amountTaxIncludedMinor;
  for (const paymentRequest of requests.sort((a, b) => a.plannedPaymentDate.localeCompare(b.plannedPaymentDate))) {
    if (remaining <= 0) break;
    const outstandingCoverage = Math.max(0, paymentRequest.totalAmountMinor - paymentRequest.invoiceCoveredAmountMinor);
    const allocated = Math.min(remaining, outstandingCoverage);
    if (!allocated) continue;
    await db.insert(invoicePaymentAllocations).values({
      invoiceId: invoice.id,
      paymentRequestId: paymentRequest.id,
      allocatedAmountMinor: allocated,
      createdBy: userId,
    });
    const newCovered = paymentRequest.invoiceCoveredAmountMinor + allocated;
    await db.update(factoryPaymentRequests).set({
      invoiceCoveredAmountMinor: newCovered,
      status: newCovered >= paymentRequest.totalAmountMinor ? "generated" : "waiting_invoice",
      updatedAt: new Date().toISOString(),
    }).where(eq(factoryPaymentRequests.id, paymentRequest.id));
    remaining -= allocated;
  }
}

async function recordPayment(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "finance"]);
  const paymentRequestId = Number(body.paymentRequestId);
  const amountMinor = Math.trunc(Number(body.amountMinor));
  const paidAt = String(body.paidAt ?? "");
  const bankReference = String(body.bankReference ?? "").trim();
  if (!paymentRequestId || amountMinor <= 0 || !paidAt || !bankReference) {
    return Response.json({ error: "请款单、付款金额、付款日期和银行流水号不能为空。" }, { status: 400 });
  }
  const challengeNo = body.challengeNo;
  const stepUpScope = `finance:record_payment:${paymentRequestId}`;
  if (access.localPreview) {
    await consumeVerifiedStepUp(null, { challengeNo, userId: access.userId, localPreview: true, scope: stepUpScope });
    return Response.json({ payment: { id: 0 }, preview: true }, { status: 201 });
  }
  const db = getDb();
  const result = await withLockedPaymentRequest(db, paymentRequestId, async tx => {
    const [paymentRequest] = await tx.select().from(factoryPaymentRequests).where(eq(factoryPaymentRequests.id, paymentRequestId)).limit(1);
    if (!paymentRequest) throw new AccessError(404, "请款单不存在。");
    if (!(["generated", "submitted_to_finance", "partially_paid"] as string[]).includes(paymentRequest.status)) {
      throw new AccessError(409, "请款单当前状态不允许登记付款。");
    }
    if (paymentRequest.invoiceCoveredAmountMinor < paymentRequest.totalAmountMinor) {
      throw new AccessError(409, "发票尚未完成双重核验或覆盖金额不足，禁止登记付款。");
    }
    const ledger = await tx.select({
      amountMinor: paymentRecords.amountMinor,
      recordType: paymentRecords.recordType,
      invoiceExceptionId: paymentRecords.invoiceExceptionId,
    }).from(paymentRecords).where(eq(paymentRecords.paymentRequestId, paymentRequestId));
    const capacity = evaluatePaymentCapacity({
      totalAmountMinor: paymentRequest.totalAmountMinor,
      ledgerRecords: ledger,
      incomingAmountMinor: amountMinor,
    });
    if (!capacity.ledgerWithinBounds) {
      throw new AccessError(409, "请款单付款账本净额异常，禁止继续付款。");
    }
    if (capacity.wouldExceed) {
      throw new AccessError(409, "本次付款将超过请款金额，禁止登记。");
    }

    await consumeVerifiedStepUp(tx, { challengeNo, userId: access.userId, localPreview: false, scope: stepUpScope });
    const created = await insertOne<typeof paymentRecords.$inferSelect>(tx.insert(paymentRecords).values({
      paymentRequestId,
      amountMinor,
      paidAt,
      bankReference,
      recordType: "payment",
      recordedBy: access.userId,
    }), id => tx.select().from(paymentRecords).where(eq(paymentRecords.id, id)).limit(1));
    const updatedLedger = await tx.select({
      amountMinor: paymentRecords.amountMinor,
      recordType: paymentRecords.recordType,
      invoiceExceptionId: paymentRecords.invoiceExceptionId,
    }).from(paymentRecords).where(eq(paymentRecords.paymentRequestId, paymentRequestId));
    const ledgerState = evaluatePayableLedger({
      totalAmountMinor: paymentRequest.totalAmountMinor,
      ledgerRecords: updatedLedger,
    });
    if (!ledgerState.withinBounds) {
      throw new AccessError(409, "付款后账本净额越界，已撤销本次付款。");
    }
    await tx.update(factoryPaymentRequests).set({
      status: ledgerState.netPaidAmountMinor >= paymentRequest.totalAmountMinor ? "paid" : "partially_paid",
      paidAt: ledgerState.netPaidAmountMinor >= paymentRequest.totalAmountMinor ? paidAt : null,
      paymentReference: bankReference,
      updatedAt: new Date().toISOString(),
    }).where(eq(factoryPaymentRequests.id, paymentRequestId));
    return { payment: created, paymentRequest, ledgerState };
  });
  await writeAudit(access, {
    action: "record_payment",
    module: "finance",
    entityType: "payment_record",
    entityId: result.payment.id,
    businessNo: result.paymentRequest.requestNo,
    after: result.payment,
    sensitiveView: true,
    request,
  });
  return Response.json({
    payment: result.payment,
    paymentStatus: result.ledgerState.netPaidAmountMinor >= result.paymentRequest.totalAmountMinor ? "paid" : "partially_paid",
    remainingAmountMinor: result.ledgerState.remainingAmountMinor,
  }, { status: 201 });
}
