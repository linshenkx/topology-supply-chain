import { createHash, randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../platform/registrations.js";
import { consumeStepUpClaim } from "../platform/approvals.js";
import { PlatformError } from "../errors.js";
import type { R3CommandContext } from "./command.js";
import {
  audit,
  domainEvent,
  hasRole,
  integer,
  jsonObject,
  oneOf,
  optionalInteger,
  requireCleanFile,
  requireRole,
  string,
  type Row,
} from "./support.js";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function payloadDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

function objectVersion(row: Row): number {
  const value = Number(row.objectVersion);
  if (!Number.isSafeInteger(value) || value < 1) throw new PlatformError(409, "VERSION_CONFLICT", "Finance version unavailable");
  return value;
}

function payableNet(rows: readonly Row[], totalAmountMinor: number): number {
  let net = 0;
  for (const row of rows) {
    const amount = Number(row.amountMinor);
    const type = String(row.recordType);
    const exceptionId = row.invoiceExceptionId;
    if (!Number.isSafeInteger(amount) ||
        (type === "reversal" ? amount >= 0 : amount <= 0) ||
        !["payment", "refund", "correction", "reversal"].includes(type) ||
        (type === "payment" && exceptionId !== null) ||
        (type === "refund" && exceptionId === null)) {
      throw new PlatformError(409, "CONFLICT", "Payment ledger is invalid");
    }
    // Refund remediation is linked to an invoice exception and does not reopen
    // an already-paid request. Corrections/reversals without that link do.
    if (type !== "refund" && exceptionId === null) net += amount;
    if (!Number.isSafeInteger(net)) throw new PlatformError(409, "CONFLICT", "Payment ledger exceeds safe bounds");
  }
  if (net < 0 || net > totalAmountMinor) {
    throw new PlatformError(409, "CONFLICT", "Payment ledger is outside payable bounds");
  }
  return net;
}

async function stepUp(
  command: R3CommandContext,
  input: { challengeNo: string; action: string; objectType: string; objectId: number; objectVersion: number; payload: Record<string, unknown> },
): Promise<void> {
  if (command.access.sessionId === null) throw new PlatformError(403, "FORBIDDEN", "Step-up requires an authenticated session");
  await consumeStepUpClaim(command.transaction, {
    challengeNo: input.challengeNo,
    userId: command.access.userId,
    sessionId: command.access.sessionId,
    action: input.action,
    objectType: input.objectType,
    objectId: String(input.objectId),
    objectVersion: input.objectVersion,
    requestDigest: payloadDigest(input.payload),
  });
}

async function claimBusinessKey(
  command: R3CommandContext,
  type: string,
  key: string,
): Promise<void> {
  try {
    await command.transaction.execute(
      `INSERT INTO r3_business_keys (key_type, key_value, aggregate_id, created_at)
       VALUES (?, ?, 'pending', CURRENT_TIMESTAMP(3))`, [type, key],
    );
  } catch {
    throw new PlatformError(409, "CONFLICT", "Financial business key already exists");
  }
}

async function allocateInvoice(command: R3CommandContext, invoice: Row): Promise<number> {
  const requests = await command.transaction.query<Row>(
    `SELECT DISTINCT pr.id, pr.total_amount_minor AS totalAmountMinor,
            pr.invoice_covered_amount_minor AS invoiceCoveredAmountMinor,
            pr.planned_payment_date AS plannedPaymentDate, pr.status
     FROM factory_payment_request_items items
     JOIN factory_payment_requests pr ON pr.id = items.payment_request_id
     WHERE items.purchase_order_id = ?
     ORDER BY pr.planned_payment_date ASC, pr.id ASC FOR UPDATE`, [invoice.purchaseOrderId],
  );
  let remaining = Number(invoice.amountTaxIncludedMinor);
  let allocatedTotal = 0;
  for (const request of requests) {
    if (remaining === 0) break;
    const outstanding = Math.max(0, Number(request.totalAmountMinor) - Number(request.invoiceCoveredAmountMinor));
    const allocated = Math.min(remaining, outstanding);
    if (allocated === 0) continue;
    await command.transaction.execute(
      `INSERT INTO invoice_payment_allocations (
         invoice_id, payment_request_id, allocated_amount_minor, status, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [invoice.id, request.id, allocated, command.access.userId],
    );
    const newCoverage = Number(request.invoiceCoveredAmountMinor) + allocated;
    await command.transaction.execute(
      `UPDATE factory_payment_requests
       SET invoice_covered_amount_minor = ?, status = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [newCoverage, newCoverage >= Number(request.totalAmountMinor) ? "generated" : "waiting_invoice", request.id],
    );
    remaining -= allocated;
    allocatedTotal += allocated;
  }
  return allocatedTotal;
}

export async function financeCommand(
  context: DomainRegistrationContext,
  command: R3CommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  const body = jsonObject(raw);
  const action = oneOf(body.action, [
    "create_invoice", "verify_invoice", "record_payment", "invalidate_invoice",
    "link_replacement_invoice", "record_refund", "request_record_correction", "release_invoice_risk",
  ] as const, "action");

  if (action === "create_invoice") {
    requireRole(command.access, ["admin", "supply_chain"]);
    const factoryId = integer(body.factoryId, "factoryId");
    const purchaseOrderId = integer(body.purchaseOrderId, "purchaseOrderId");
    const invoiceNo = string(body.invoiceNo, "invoiceNo", 191);
    const invoiceType = oneOf(body.invoiceType, ["vat_special", "vat_general", "other"] as const, "invoiceType");
    const coverageMode = oneOf(body.coverageMode, ["full_order", "delivery_batch", "order", "shipment"] as const, "coverageMode");
    const normalizedCoverage = coverageMode === "shipment" ? "delivery_batch" : coverageMode === "order" ? "full_order" : coverageMode;
    const amount = integer(body.amountTaxIncludedMinor, "amountTaxIncludedMinor");
    const taxAmount = integer(body.taxAmountMinor, "taxAmountMinor", 0);
    const expectedAmount = normalizedCoverage === "full_order"
      ? 1
      : integer(body.expectedAmountMinor, "expectedAmountMinor");
    const issuedAt = string(body.issuedAt, "issuedAt", 100);
    const file = await requireCleanFile(command.transaction, command.access, integer(body.fileId, "fileId"),
      { category: "invoice", entityType: "purchase_order", entityId: purchaseOrderId });
    const orders = await command.transaction.query<Row>(
      `SELECT id, total_tax_included_minor AS totalTaxIncludedMinor
       FROM purchase_orders WHERE id = ? LIMIT 1 FOR SHARE`, [purchaseOrderId],
    );
    if (orders[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Purchase order not found");
    const expected = normalizedCoverage === "full_order" ? Number(orders[0].totalTaxIncludedMinor) : expectedAmount;
    const inserted = await command.transaction.execute(
      `INSERT INTO factory_invoices (
         factory_id, purchase_order_id, coverage_mode, delivery_batch_id, invoice_no,
         invoice_type, amount_tax_included_minor, tax_amount_minor, issued_at, file_key,
         status, expected_amount_minor, amount_matches_expected, mismatch_amount_minor,
         maintained_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [factoryId, purchaseOrderId, normalizedCoverage, normalizedCoverage === "delivery_batch" ? optionalInteger(body.deliveryBatchId, "deliveryBatchId") : null,
       invoiceNo, invoiceType, amount, taxAmount, issuedAt, file.objectKey, expected, amount === expected ? 1 : 0,
       amount - expected, command.access.userId],
    );
    const id = inserted.insertId!;
    await audit(command.transaction, command.access, command.request, {
      action: "create", module: "finance", entityType: "invoice", entityId: id,
      businessNo: invoiceNo, after: { factoryId, purchaseOrderId, amountTaxIncludedMinor: amount, expectedAmountMinor: expected, fileId: file.id },
      sensitiveView: true,
    });
    await domainEvent(context, command.transaction, { type: "InvoiceRegistered", aggregateType: "invoice", aggregateId: id });
    return { invoice: { id, factoryId, purchaseOrderId, invoiceNo, invoiceType, coverageMode: normalizedCoverage,
      amountTaxIncludedMinor: amount, expectedAmountMinor: expected, amountMatchesExpected: amount === expected, status: "received" },
      verificationBlocked: amount !== expected };
  }

  if (action === "verify_invoice") {
    requireRole(command.access, ["admin", "supply_chain", "finance"]);
    const invoiceId = integer(body.invoiceId, "invoiceId");
    const verifierRole = oneOf(body.verifierRole, ["supply_chain", "finance"] as const, "verifierRole");
    const decision = oneOf(body.decision, ["approved", "rejected"] as const, "decision");
    if (!hasRole(command.access, ["admin", verifierRole])) throw new PlatformError(403, "FORBIDDEN", "Cannot act for another verifier role");
    const invoices = await command.transaction.query<Row>(
      `SELECT id, invoice_no AS invoiceNo, purchase_order_id AS purchaseOrderId,
              amount_tax_included_minor AS amountTaxIncludedMinor,
              amount_matches_expected AS amountMatchesExpected, status
       FROM factory_invoices WHERE id = ? LIMIT 1 FOR UPDATE`, [invoiceId],
    );
    const invoice = invoices[0];
    if (invoice === undefined) throw new PlatformError(404, "NOT_FOUND", "Invoice not found");
    if (invoice.status !== "received") {
      throw new PlatformError(409, "VERSION_CONFLICT", "Invoice is not in a verifiable state");
    }
    if (decision === "approved" && Number(invoice.amountMatchesExpected) !== 1) {
      throw new PlatformError(409, "CONFLICT", "Invoice amount mismatch blocks approval");
    }
    const existing = await command.transaction.query<Row>(
      `SELECT verifier_role AS verifierRole, decision, verified_by AS verifiedBy
       FROM invoice_verifications WHERE invoice_id = ? ORDER BY id ASC FOR UPDATE`, [invoiceId],
    );
    if (existing.some((row) => row.verifierRole === verifierRole)) throw new PlatformError(409, "CONFLICT", "Verifier role already decided");
    if (existing.some((row) => Number(row.verifiedBy) === command.access.userId)) {
      throw new PlatformError(409, "CONFLICT", "One person cannot perform both verification roles");
    }
    await command.transaction.execute(
      `INSERT INTO invoice_verifications (
         invoice_id, verifier_role, decision, rejection_reason, verified_by, verified_at
       ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
      [invoiceId, verifierRole, decision, decision === "rejected" ? string(body.rejectionReason, "rejectionReason") : null, command.access.userId],
    );
    const approved = new Set(existing.filter((row) => row.decision === "approved").map((row) => String(row.verifierRole)));
    if (decision === "approved") approved.add(verifierRole);
    const fullyVerified = approved.has("supply_chain") && approved.has("finance");
    let allocatedAmountMinor = 0;
    if (decision === "rejected") {
      const updated = await command.transaction.execute(
        `UPDATE factory_invoices SET status = 'rejected', updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'received'`, [invoiceId],
      );
      if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Invoice changed concurrently");
    } else if (fullyVerified) {
      const updated = await command.transaction.execute(
        `UPDATE factory_invoices SET status = 'verified', updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'received'`, [invoiceId],
      );
      if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Invoice changed concurrently");
      allocatedAmountMinor = await allocateInvoice(command, invoice);
    }
    await audit(command.transaction, command.access, command.request, {
      action: "verify", module: "finance", entityType: "invoice", entityId: invoiceId,
      businessNo: String(invoice.invoiceNo), after: { verifierRole, decision, fullyVerified, allocatedAmountMinor }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: decision === "rejected" ? "InvoiceRejected" : fullyVerified ? "InvoiceVerified" : "InvoiceVerificationRecorded",
      aggregateType: "invoice", aggregateId: invoiceId, deduplicationSuffix: verifierRole,
    });
    return { success: true, fullyVerified, allocatedAmountMinor };
  }

  if (action === "invalidate_invoice") {
    requireRole(command.access, ["admin", "finance"]);
    const invoiceId = integer(body.invoiceId, "invoiceId");
    const exceptionType = oneOf(body.exceptionType, ["red_invoice", "voided"] as const, "exceptionType");
    const reason = string(body.reason, "reason");
    const replacementDeadline = string(body.replacementDeadline, "replacementDeadline", 100);
    const invoices = await command.transaction.query<Row>(
      `SELECT id, invoice_no AS invoiceNo, amount_tax_included_minor AS amountTaxIncludedMinor, status
       FROM factory_invoices WHERE id = ? LIMIT 1 FOR UPDATE`, [invoiceId],
    );
    const invoice = invoices[0];
    if (invoice === undefined) throw new PlatformError(404, "NOT_FOUND", "Invoice not found");
    const active = await command.transaction.query<Row>(
      `SELECT id FROM invoice_exceptions WHERE invoice_id = ? AND status <> 'resolved' LIMIT 1 FOR UPDATE`, [invoiceId],
    );
    if (active.length > 0) throw new PlatformError(409, "CONFLICT", "Invoice already has an active exception");
    const allocations = await command.transaction.query<Row>(
      `SELECT id, payment_request_id AS paymentRequestId, allocated_amount_minor AS allocatedAmountMinor
       FROM invoice_payment_allocations WHERE invoice_id = ? AND status = 'active'
       ORDER BY payment_request_id ASC FOR UPDATE`, [invoiceId],
    );
    for (const allocation of allocations) {
      await command.transaction.execute(
        `UPDATE invoice_payment_allocations SET status = 'frozen', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [allocation.id],
      );
      await command.transaction.execute(
        `UPDATE factory_payment_requests
         SET invoice_covered_amount_minor = GREATEST(0, invoice_covered_amount_minor - ?),
             status = 'invoice_exception_frozen', updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`, [allocation.allocatedAmountMinor, allocation.paymentRequestId],
      );
    }
    await command.transaction.execute(
      `UPDATE factory_invoices SET status = 'invalidated', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`, [invoiceId],
    );
    const inserted = await command.transaction.execute(
      `INSERT INTO invoice_exceptions (
         invoice_id, exception_type, affected_amount_minor, replacement_deadline,
         replacement_covered_amount_minor, refunded_amount_minor, status, reason, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 0, 'awaiting_remediation', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [invoiceId, exceptionType, invoice.amountTaxIncludedMinor, replacementDeadline, reason, command.access.userId],
    );
    const exceptionId = inserted.insertId!;
    await audit(command.transaction, command.access, command.request, {
      action: "invalidate", module: "finance", entityType: "invoice", entityId: invoiceId,
      businessNo: String(invoice.invoiceNo), before: invoice, after: { exceptionId, exceptionType, reason, replacementDeadline }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: "InvoiceInvalidated", aggregateType: "invoice_exception", aggregateId: exceptionId,
      payload: { invoiceId, replacementDeadline },
    });
    return { exception: { id: exceptionId, invoiceId, exceptionType, affectedAmountMinor: invoice.amountTaxIncludedMinor,
      replacementDeadline, status: "awaiting_remediation" }, frozenPaymentRequestCount: allocations.length };
  }

  if (action === "link_replacement_invoice") {
    requireRole(command.access, ["admin", "finance", "supply_chain"]);
    const exceptionId = integer(body.invoiceExceptionId, "invoiceExceptionId");
    const replacementInvoiceId = integer(body.replacementInvoiceId, "replacementInvoiceId");
    const covered = integer(body.coveredAmountMinor, "coveredAmountMinor");
    const rows = await command.transaction.query<Row>(
      `SELECT e.id, e.invoice_id AS invoiceId, e.affected_amount_minor AS affectedAmountMinor,
              e.replacement_covered_amount_minor AS replacementCoveredAmountMinor,
              e.refunded_amount_minor AS refundedAmountMinor, e.status,
              original.purchase_order_id AS originalPurchaseOrderId,
              replacement.purchase_order_id AS replacementPurchaseOrderId,
              replacement.amount_tax_included_minor AS replacementAmountMinor,
              replacement.status AS replacementStatus
       FROM invoice_exceptions e
       JOIN factory_invoices original ON original.id = e.invoice_id
       JOIN factory_invoices replacement ON replacement.id = ?
       WHERE e.id = ? LIMIT 1 FOR UPDATE`, [replacementInvoiceId, exceptionId],
    );
    const exception = rows[0];
    if (exception === undefined) throw new PlatformError(404, "NOT_FOUND", "Invoice exception or replacement invoice not found");
    if (exception.status === "resolved" || exception.replacementStatus !== "verified" ||
        exception.originalPurchaseOrderId !== exception.replacementPurchaseOrderId) {
      throw new PlatformError(409, "CONFLICT", "Replacement invoice is not eligible");
    }
    if (covered > Number(exception.replacementAmountMinor) ||
        Number(exception.replacementCoveredAmountMinor) + Number(exception.refundedAmountMinor) + covered > Number(exception.affectedAmountMinor)) {
      throw new PlatformError(409, "CONFLICT", "Replacement coverage exceeds the exception amount");
    }
    const inserted = await command.transaction.execute(
      `INSERT INTO replacement_invoice_links (
         invoice_exception_id, replacement_invoice_id, covered_amount_minor, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'verified', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [exceptionId, replacementInvoiceId, covered],
    );
    const replacementTotal = Number(exception.replacementCoveredAmountMinor) + covered;
    const resolved = replacementTotal + Number(exception.refundedAmountMinor) === Number(exception.affectedAmountMinor);
    await command.transaction.execute(
      `UPDATE invoice_exceptions
       SET replacement_covered_amount_minor = ?, status = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`, [replacementTotal, resolved ? "resolved" : exception.status, resolved ? new Date().toISOString() : null, exceptionId],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "link_replacement", module: "finance", entityType: "invoice_exception", entityId: exceptionId,
      after: { replacementInvoiceId, coveredAmountMinor: covered, resolved }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: "InvoiceRemediationProgressed", aggregateType: "invoice_exception", aggregateId: exceptionId,
      deduplicationSuffix: replacementInvoiceId,
    });
    return { link: { id: inserted.insertId, invoiceExceptionId: exceptionId, replacementInvoiceId, coveredAmountMinor: covered }, resolved };
  }

  if (action === "record_payment") {
    requireRole(command.access, ["admin", "finance"]);
    const paymentRequestId = integer(body.paymentRequestId, "paymentRequestId");
    const amount = integer(body.amountMinor, "amountMinor");
    const paidAt = string(body.paidAt, "paidAt", 100);
    const bankReference = string(body.bankReference, "bankReference", 191);
    const requestRows = await command.transaction.query<Row>(
      `SELECT id, request_no AS requestNo, total_amount_minor AS totalAmountMinor,
              invoice_covered_amount_minor AS invoiceCoveredAmountMinor, status,
              CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
       FROM factory_payment_requests WHERE id = ? LIMIT 1 FOR UPDATE`, [paymentRequestId],
    );
    const paymentRequest = requestRows[0];
    if (paymentRequest === undefined) throw new PlatformError(404, "NOT_FOUND", "Payment request not found");
    if (!["generated", "submitted_to_finance", "partially_paid"].includes(String(paymentRequest.status)) ||
        Number(paymentRequest.invoiceCoveredAmountMinor) < Number(paymentRequest.totalAmountMinor)) {
      throw new PlatformError(409, "CONFLICT", "Payment request is not payable");
    }
    const payload = { action, paymentRequestId, amountMinor: amount, paidAt, bankReference };
    await stepUp(command, { challengeNo: string(body.challengeNo, "challengeNo", 191), action: "record_payment",
      objectType: "finance:record_payment", objectId: paymentRequestId, objectVersion: objectVersion(paymentRequest), payload });
    await claimBusinessKey(command, "payment", bankReference);
    const ledger = await command.transaction.query<Row>(
      `SELECT amount_minor AS amountMinor, record_type AS recordType,
              invoice_exception_id AS invoiceExceptionId
       FROM payment_records WHERE payment_request_id = ? ORDER BY id ASC FOR UPDATE`, [paymentRequestId],
    );
    const net = payableNet(ledger, Number(paymentRequest.totalAmountMinor));
    if (net + amount > Number(paymentRequest.totalAmountMinor)) {
      throw new PlatformError(409, "CONFLICT", "Payment would exceed the payable ledger");
    }
    const inserted = await command.transaction.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         recorded_by, review_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'payment', ?, 'not_required', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [paymentRequestId, amount, paidAt, bankReference, command.access.userId],
    );
    const newNet = net + amount;
    await command.transaction.execute(
      `UPDATE factory_payment_requests
       SET status = ?, paid_at = ?, payment_reference = ?,
           updated_at = GREATEST(DATE_ADD(updated_at, INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))
       WHERE id = ?`,
      [newNet === Number(paymentRequest.totalAmountMinor) ? "paid" : "partially_paid",
       newNet === Number(paymentRequest.totalAmountMinor) ? paidAt : null, bankReference, paymentRequestId],
    );
    await command.transaction.execute(
      `UPDATE r3_business_keys SET aggregate_id = ? WHERE key_type = 'payment' AND key_value = ?`,
      [String(inserted.insertId), bankReference],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "record_payment", module: "finance", entityType: "payment_record", entityId: inserted.insertId!,
      businessNo: String(paymentRequest.requestNo), after: { paymentRequestId, amountMinor: amount, paidAt, bankReference }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: "PaymentRecorded", aggregateType: "payment_request", aggregateId: paymentRequestId,
      deduplicationSuffix: inserted.insertId!,
    });
    return { payment: { id: inserted.insertId, paymentRequestId, amountMinor: amount, paidAt, bankReference, recordType: "payment" },
      paymentStatus: newNet === Number(paymentRequest.totalAmountMinor) ? "paid" : "partially_paid",
      remainingAmountMinor: Number(paymentRequest.totalAmountMinor) - newNet };
  }

  if (action === "record_refund") {
    requireRole(command.access, ["admin", "finance"]);
    const exceptionId = integer(body.invoiceExceptionId, "invoiceExceptionId");
    const paymentRequestId = integer(body.paymentRequestId, "paymentRequestId");
    const amount = integer(body.amountMinor, "amountMinor");
    const paidAt = string(body.paidAt, "paidAt", 100);
    const bankReference = string(body.bankReference, "bankReference", 191);
    const requestRows = await command.transaction.query<Row>(
      `SELECT id, total_amount_minor AS totalAmountMinor, status
       FROM factory_payment_requests WHERE id = ? LIMIT 1 FOR UPDATE`, [paymentRequestId],
    );
    const paymentRequest = requestRows[0];
    if (paymentRequest === undefined) throw new PlatformError(404, "NOT_FOUND", "Payment request not found");
    const rows = await command.transaction.query<Row>(
      `SELECT e.id, e.affected_amount_minor AS affectedAmountMinor,
              e.replacement_covered_amount_minor AS replacementCoveredAmountMinor,
              e.refunded_amount_minor AS refundedAmountMinor, e.status,
              i.purchase_order_id AS purchaseOrderId,
              CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', e.updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
       FROM invoice_exceptions e JOIN factory_invoices i ON i.id = e.invoice_id
       WHERE e.id = ? LIMIT 1 FOR UPDATE`, [exceptionId],
    );
    const exception = rows[0];
    if (exception === undefined || exception.status === "resolved") throw new PlatformError(409, "CONFLICT", "Invoice exception is not refundable");
    const requestAllocations = await command.transaction.query<Row>(
      `SELECT id, allocated_amount_minor AS allocatedAmountMinor, status
       FROM invoice_payment_allocations
       WHERE invoice_id = (SELECT invoice_id FROM invoice_exceptions WHERE id = ?)
         AND payment_request_id = ? ORDER BY id ASC FOR UPDATE`, [exceptionId, paymentRequestId],
    );
    if (requestAllocations.length !== 1 || Number(requestAllocations[0]?.allocatedAmountMinor) <= 0) {
      throw new PlatformError(409, "CONFLICT", "Refund request is not allocated to the exception invoice");
    }
    if (!["paid", "partially_paid"].includes(String(paymentRequest.status))) {
      throw new PlatformError(409, "CONFLICT", "Refund request has no refundable paid balance");
    }
    const ledgerBefore = await command.transaction.query<Row>(
      `SELECT amount_minor AS amountMinor, record_type AS recordType,
              invoice_exception_id AS invoiceExceptionId
       FROM payment_records WHERE payment_request_id = ? ORDER BY id ASC FOR UPDATE`, [paymentRequestId],
    );
    const paidNet = payableNet(ledgerBefore, Number(paymentRequest.totalAmountMinor));
    const refundNet = ledgerBefore.reduce((sum, row) =>
      Number(row.invoiceExceptionId) === exceptionId ? sum + Number(row.amountMinor) : sum, 0);
    if (!Number.isSafeInteger(refundNet) || refundNet < 0 || refundNet !== Number(exception.refundedAmountMinor)) {
      throw new PlatformError(409, "CONFLICT", "Refund ledger and exception projection disagree");
    }
    if (refundNet + amount > paidNet) {
      throw new PlatformError(409, "CONFLICT", "Refund exceeds the paid net amount");
    }
    const payload = { action, invoiceExceptionId: exceptionId, paymentRequestId, amountMinor: amount, paidAt, bankReference };
    await stepUp(command, { challengeNo: string(body.challengeNo, "challengeNo", 191), action: "record_refund",
      objectType: "finance:record_refund", objectId: exceptionId, objectVersion: objectVersion(exception), payload });
    if (Number(exception.replacementCoveredAmountMinor) + Number(exception.refundedAmountMinor) + amount > Number(exception.affectedAmountMinor)) {
      throw new PlatformError(409, "CONFLICT", "Refund exceeds the remaining exception amount");
    }
    await claimBusinessKey(command, "refund", bankReference);
    const inserted = await command.transaction.execute(
      `INSERT INTO payment_records (
         payment_request_id, amount_minor, paid_at, bank_reference, record_type,
         invoice_exception_id, recorded_by, review_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'refund', ?, ?, 'not_required', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [paymentRequestId, amount, paidAt, bankReference, exceptionId, command.access.userId],
    );
    const ledger = await command.transaction.query<Row>(
      `SELECT amount_minor AS amountMinor, record_type AS recordType,
              invoice_exception_id AS invoiceExceptionId
       FROM payment_records WHERE payment_request_id = ? ORDER BY id ASC FOR UPDATE`, [paymentRequestId],
    );
    payableNet(ledger, Number(paymentRequest.totalAmountMinor));
    const refundedTotal = Number(exception.refundedAmountMinor) + amount;
    const resolved = refundedTotal + Number(exception.replacementCoveredAmountMinor) === Number(exception.affectedAmountMinor);
    const projected = await command.transaction.execute(
      `UPDATE invoice_exceptions
       SET refunded_amount_minor = ?, status = ?, resolved_at = ?,
           updated_at = GREATEST(DATE_ADD(updated_at, INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))
       WHERE id = ? AND status = ? AND refunded_amount_minor = ?`,
      [refundedTotal, resolved ? "resolved" : exception.status, resolved ? new Date().toISOString() : null,
       exceptionId, exception.status, exception.refundedAmountMinor],
    );
    if (projected.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Invoice exception changed concurrently");
    await command.transaction.execute(
      `UPDATE r3_business_keys SET aggregate_id = ? WHERE key_type = 'refund' AND key_value = ?`,
      [String(inserted.insertId), bankReference],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "record_refund", module: "finance", entityType: "payment_record", entityId: inserted.insertId!,
      after: { exceptionId, paymentRequestId, amountMinor: amount, paidAt, bankReference }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: "RefundRecorded", aggregateType: "invoice_exception", aggregateId: exceptionId,
      deduplicationSuffix: inserted.insertId!,
    });
    return { refund: { id: inserted.insertId, paymentRequestId, amountMinor: amount, paidAt, bankReference, recordType: "refund" },
      resolved, remainingAmountMinor: Number(exception.affectedAmountMinor) - refundedTotal - Number(exception.replacementCoveredAmountMinor) };
  }

  if (action === "request_record_correction") {
    requireRole(command.access, ["admin", "finance"]);
    const paymentRecordId = integer(body.paymentRecordId, "paymentRecordId");
    const reason = string(body.reason, "reason");
    const proposedPaymentRequestId = integer(body.proposedPaymentRequestId, "proposedPaymentRequestId");
    const proposedAmountMinor = integer(body.proposedAmountMinor, "proposedAmountMinor");
    const proposedPaidAt = string(body.proposedPaidAt, "proposedPaidAt", 100);
    const proposedBankReference = string(body.proposedBankReference, "proposedBankReference", 191);
    const rows = await command.transaction.query<Row>(
      `SELECT id, payment_request_id AS paymentRequestId, amount_minor AS amountMinor,
              paid_at AS paidAt, bank_reference AS bankReference, record_type AS recordType,
              invoice_exception_id AS invoiceExceptionId,
              CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
       FROM payment_records WHERE id = ? LIMIT 1 FOR UPDATE`, [paymentRecordId],
    );
    const original = rows[0];
    if (original === undefined || !["payment", "refund"].includes(String(original.recordType))) {
      throw new PlatformError(404, "NOT_FOUND", "Correctable financial record not found");
    }
    const payload = { action, paymentRecordId, reason, proposedPaymentRequestId, proposedAmountMinor, proposedPaidAt, proposedBankReference };
    await stepUp(command, { challengeNo: string(body.challengeNo, "challengeNo", 191), action: "request_record_correction",
      objectType: "finance:request_record_correction", objectId: paymentRecordId, objectVersion: objectVersion(original), payload });
    const approvalNo = `AP-FINCORR-${randomUUID()}`;
    const inserted = await command.transaction.execute(
      `INSERT INTO approval_requests (
         request_no, workflow_type, entity_type, entity_id, summary, payload_json,
         high_risk, status, requested_by, requested_at, sms_verified_at, created_at, updated_at
       ) VALUES (?, 'financial_record_correction', 'payment_record', ?, ?, ?, 1, 'pending', ?,
                 CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [approvalNo, paymentRecordId, `Financial record correction ${paymentRecordId}`,
       JSON.stringify({ proposedPaymentRequestId, proposedAmountMinor, proposedPaidAt, proposedBankReference,
         originalRecordType: original.recordType, invoiceExceptionId: original.invoiceExceptionId, reason }), command.access.userId],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "request_correction", module: "finance", entityType: "payment_record", entityId: paymentRecordId,
      before: original, after: { approvalId: inserted.insertId, reason }, sensitiveView: true,
    });
    await domainEvent(context, command.transaction, {
      type: "FinancialCorrectionRequested", aggregateType: "payment_record", aggregateId: paymentRecordId,
      deduplicationSuffix: inserted.insertId!, payload: { approvalId: inserted.insertId! },
    });
    return { approval: { id: inserted.insertId, requestNo: approvalNo, workflowType: "financial_record_correction", status: "pending" } };
  }

  requireRole(command.access, ["admin", "supply_chain_lead"]);
  const exceptionId = integer(body.invoiceExceptionId, "invoiceExceptionId");
  const reason = string(body.reason, "reason");
  const file = await requireCleanFile(command.transaction, command.access, integer(body.evidenceFileId, "evidenceFileId"),
    { category: "invoice_risk_release", entityType: "invoice_exception", entityId: exceptionId });
  const rows = await command.transaction.query<Row>(
    `SELECT id, status,
            CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
     FROM invoice_exceptions WHERE id = ? LIMIT 1 FOR UPDATE`, [exceptionId],
  );
  const exception = rows[0];
  if (exception === undefined || exception.status !== "risk_warning") {
    throw new PlatformError(409, "CONFLICT", "Invoice exception is not a releasable risk warning");
  }
  const payload = { action, invoiceExceptionId: exceptionId, reason, evidenceFileId: Number(file.id) };
  await stepUp(command, { challengeNo: string(body.challengeNo, "challengeNo", 191), action: "release_invoice_risk",
    objectType: "finance:release_invoice_risk", objectId: exceptionId, objectVersion: objectVersion(exception), payload });
  const updated = await command.transaction.execute(
    `UPDATE invoice_exceptions
     SET status = 'awaiting_remediation', risk_released_by = ?, risk_released_at = CURRENT_TIMESTAMP(3),
         risk_release_reason = ?, risk_release_evidence_file_key = ?,
         updated_at = GREATEST(DATE_ADD(updated_at, INTERVAL 1000 MICROSECOND), CURRENT_TIMESTAMP(3))
     WHERE id = ? AND status = 'risk_warning'`,
    [command.access.userId, reason, file.objectKey, exceptionId],
  );
  if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Invoice exception changed concurrently");
  await audit(command.transaction, command.access, command.request, {
    action: "release_warning", module: "finance", entityType: "invoice_exception", entityId: exceptionId,
    before: exception, after: { status: "awaiting_remediation", reason, evidenceFileId: file.id }, sensitiveView: true,
  });
  await domainEvent(context, command.transaction, { type: "InvoiceRiskReleased", aggregateType: "invoice_exception", aggregateId: exceptionId });
  return { success: true, invoiceExceptionId: exceptionId, status: "awaiting_remediation" };
}
