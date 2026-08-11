import {
  apiErrorSchemaId,
  financeResponseSchema,
  financeSchemaId,
  type FinanceInvoice,
  type FinanceInvoiceException,
  type FinanceInvoicePaymentAllocation,
  type FinanceInvoiceVerification,
  type FinancePaymentRecord,
  type FinancePaymentRequest,
  type FinancePaymentRequestItem,
  type FinancePurchaseOrder,
  type FinanceReplacementInvoiceLink,
  type FinanceResponse,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const ALLOWED_ROLES = new Set(["admin", "supply_chain", "finance"]);

const INVOICE_LIMIT = 200;
const PAYMENT_REQUEST_LIMIT = 200;
const PAYMENT_LIMIT = 300;
const VERIFICATION_LIMIT = 400;
const ALLOCATION_LIMIT = 400;
const EXCEPTION_LIMIT = 200;
const REPLACEMENT_LINK_LIMIT = 400;
const REQUEST_ITEM_LIMIT = 500;
const PURCHASE_ORDER_LIMIT = 300;

const INVOICE_QUERY = `SELECT
  id,
  invoice_no AS invoiceNo,
  purchase_order_id AS purchaseOrderId,
  amount_tax_included_minor AS amountTaxIncludedMinor,
  expected_amount_minor AS expectedAmountMinor,
  amount_matches_expected AS amountMatchesExpected,
  status,
  issued_at AS issuedAt
FROM factory_invoices
ORDER BY created_at DESC, id DESC
LIMIT ${INVOICE_LIMIT}`;

const PAYMENT_REQUEST_QUERY = `SELECT
  id,
  request_no AS requestNo,
  factory_id AS factoryId,
  planned_payment_date AS plannedPaymentDate,
  total_amount_minor AS totalAmountMinor,
  invoice_covered_amount_minor AS invoiceCoveredAmountMinor,
  status,
  CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
FROM factory_payment_requests
ORDER BY created_at DESC, id DESC
LIMIT ${PAYMENT_REQUEST_LIMIT}`;

const PAYMENT_QUERY = `SELECT
  id,
  payment_request_id AS paymentRequestId,
  amount_minor AS amountMinor,
  paid_at AS paidAt,
  bank_reference AS bankReference,
  record_type AS recordType,
  invoice_exception_id AS invoiceExceptionId,
  CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
FROM payment_records
ORDER BY created_at DESC, id DESC
LIMIT ${PAYMENT_LIMIT}`;

const VERIFICATION_QUERY = `SELECT
  id,
  invoice_id AS invoiceId,
  verifier_role AS verifierRole,
  decision,
  rejection_reason AS rejectionReason
FROM invoice_verifications
ORDER BY verified_at DESC, id DESC
LIMIT ${VERIFICATION_LIMIT}`;

const ALLOCATION_QUERY = `SELECT
  id,
  invoice_id AS invoiceId,
  payment_request_id AS paymentRequestId,
  allocated_amount_minor AS allocatedAmountMinor,
  status
FROM invoice_payment_allocations
ORDER BY created_at DESC, id DESC
LIMIT ${ALLOCATION_LIMIT}`;

const EXCEPTION_QUERY = `SELECT
  id,
  invoice_id AS invoiceId,
  exception_type AS exceptionType,
  affected_amount_minor AS affectedAmountMinor,
  replacement_deadline AS replacementDeadline,
  replacement_covered_amount_minor AS replacementCoveredAmountMinor,
  refunded_amount_minor AS refundedAmountMinor,
  status,
  reason,
  CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', updated_at) DIV 1000 AS UNSIGNED) AS objectVersion
FROM invoice_exceptions
ORDER BY created_at DESC, id DESC
LIMIT ${EXCEPTION_LIMIT}`;

const REPLACEMENT_LINK_QUERY = `SELECT
  id,
  invoice_exception_id AS invoiceExceptionId,
  replacement_invoice_id AS replacementInvoiceId,
  covered_amount_minor AS coveredAmountMinor,
  status
FROM replacement_invoice_links
ORDER BY created_at DESC, id DESC
LIMIT ${REPLACEMENT_LINK_LIMIT}`;

const REQUEST_ITEM_QUERY = `SELECT
  id,
  payment_request_id AS paymentRequestId,
  payment_schedule_id AS paymentScheduleId,
  purchase_order_id AS purchaseOrderId,
  triggered_by_delivery_batch_id AS triggeredByDeliveryBatchId,
  amount_minor AS amountMinor
FROM factory_payment_request_items
ORDER BY id DESC
LIMIT ${REQUEST_ITEM_LIMIT}`;

const PURCHASE_ORDER_QUERY = `SELECT
  id,
  order_no AS orderNo,
  total_tax_included_minor AS totalTaxIncludedMinor
FROM purchase_orders
ORDER BY created_at DESC, id DESC
LIMIT ${PURCHASE_ORDER_LIMIT}`;

type FinanceAccessContext = Pick<
  AccessContext,
  | "factoryId"
  | "localPreview"
  | "organizationName"
  | "roles"
  | "supplierId"
  | "userId"
>;
type DataRow = Record<string, unknown>;

export interface FinanceAuditEvent {
  access: FinanceAccessContext;
  action: "view";
  module: "finance";
  entityType: "finance_dashboard";
  entityId: "latest";
  sensitiveView: true;
  request: FastifyRequest;
}

export interface FinanceModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<FinanceAccessContext>;
  audit: (event: FinanceAuditEvent) => Promise<void> | void;
  database?: QueryExecutor;
}

export class FinanceForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("Finance access forbidden");
    this.name = "FinanceForbiddenError";
  }
}

export class FinanceUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Finance data unavailable");
    this.name = "FinanceUnavailableError";
  }
}

function unavailable(): never {
  throw new FinanceUnavailableError();
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return unavailable();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return unavailable();
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return unavailable();
  }
  return value;
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return unavailable();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value, true);
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value);
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return unavailable();
}

function enumeration<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return unavailable();
  }
  return value as Value;
}

function invoice(row: DataRow): FinanceInvoice {
  return {
    id: positiveInteger(row.id),
    invoiceNo: string(row.invoiceNo),
    purchaseOrderId: positiveInteger(row.purchaseOrderId),
    amountTaxIncludedMinor: nonNegativeInteger(row.amountTaxIncludedMinor),
    expectedAmountMinor: nonNegativeInteger(row.expectedAmountMinor),
    amountMatchesExpected: boolean(row.amountMatchesExpected),
    status: enumeration(row.status, [
      "pending",
      "received",
      "verified",
      "rejected",
      "invalidated",
    ]),
    issuedAt: string(row.issuedAt),
  };
}

function paymentRequest(row: DataRow): FinancePaymentRequest {
  return {
    id: positiveInteger(row.id),
    requestNo: string(row.requestNo),
    factoryId: positiveInteger(row.factoryId),
    plannedPaymentDate: string(row.plannedPaymentDate),
    totalAmountMinor: nonNegativeInteger(row.totalAmountMinor),
    invoiceCoveredAmountMinor: nonNegativeInteger(
      row.invoiceCoveredAmountMinor,
    ),
    status: enumeration(row.status, [
      "waiting_invoice",
      "generated",
      "submitted_to_finance",
      "paid",
      "partially_paid",
      "invoice_exception_frozen",
      "failed",
      "cancelled",
    ]),
    objectVersion: positiveInteger(row.objectVersion),
  };
}

function payment(row: DataRow): FinancePaymentRecord {
  return {
    id: positiveInteger(row.id),
    paymentRequestId: positiveInteger(row.paymentRequestId),
    amountMinor: integer(row.amountMinor),
    paidAt: string(row.paidAt),
    bankReference: string(row.bankReference),
    recordType: enumeration(row.recordType, [
      "payment",
      "reversal",
      "correction",
      "refund",
    ]),
    invoiceExceptionId: nullablePositiveInteger(row.invoiceExceptionId),
    objectVersion: positiveInteger(row.objectVersion),
  };
}

function verification(row: DataRow): FinanceInvoiceVerification {
  return {
    id: positiveInteger(row.id),
    invoiceId: positiveInteger(row.invoiceId),
    verifierRole: enumeration(row.verifierRole, ["supply_chain", "finance"]),
    decision: enumeration(row.decision, ["approved", "rejected"]),
    rejectionReason: nullableString(row.rejectionReason),
  };
}

function allocation(row: DataRow): FinanceInvoicePaymentAllocation {
  return {
    id: positiveInteger(row.id),
    invoiceId: positiveInteger(row.invoiceId),
    paymentRequestId: positiveInteger(row.paymentRequestId),
    allocatedAmountMinor: nonNegativeInteger(row.allocatedAmountMinor),
    status: enumeration(row.status, ["active", "frozen", "released"]),
  };
}

function invoiceException(row: DataRow): FinanceInvoiceException {
  return {
    id: positiveInteger(row.id),
    invoiceId: positiveInteger(row.invoiceId),
    exceptionType: enumeration(row.exceptionType, ["red_invoice", "voided"]),
    affectedAmountMinor: nonNegativeInteger(row.affectedAmountMinor),
    replacementDeadline: string(row.replacementDeadline),
    replacementCoveredAmountMinor: nonNegativeInteger(
      row.replacementCoveredAmountMinor,
    ),
    refundedAmountMinor: nonNegativeInteger(row.refundedAmountMinor),
    status: enumeration(row.status, [
      "awaiting_remediation",
      "risk_warning",
      "resolved",
    ]),
    reason: string(row.reason),
    objectVersion: positiveInteger(row.objectVersion),
  };
}

function replacementLink(row: DataRow): FinanceReplacementInvoiceLink {
  return {
    id: positiveInteger(row.id),
    invoiceExceptionId: positiveInteger(row.invoiceExceptionId),
    replacementInvoiceId: positiveInteger(row.replacementInvoiceId),
    coveredAmountMinor: nonNegativeInteger(row.coveredAmountMinor),
    status: enumeration(row.status, [
      "pending_verification",
      "verified",
      "rejected",
    ]),
  };
}

function requestItem(row: DataRow): FinancePaymentRequestItem {
  return {
    id: positiveInteger(row.id),
    paymentRequestId: positiveInteger(row.paymentRequestId),
    paymentScheduleId: positiveInteger(row.paymentScheduleId),
    purchaseOrderId: positiveInteger(row.purchaseOrderId),
    triggeredByDeliveryBatchId: positiveInteger(
      row.triggeredByDeliveryBatchId,
    ),
    amountMinor: nonNegativeInteger(row.amountMinor),
  };
}

function purchaseOrder(row: DataRow): FinancePurchaseOrder {
  return {
    id: positiveInteger(row.id),
    orderNo: string(row.orderNo),
    totalTaxIncludedMinor: nonNegativeInteger(row.totalTaxIncludedMinor),
  };
}

async function readRows<Value>(
  database: QueryExecutor,
  sql: string,
  maximum: number,
  map: (row: DataRow) => Value,
): Promise<Value[]> {
  const rows = await database.query<DataRow>(sql);
  if (rows.length > maximum) return unavailable();
  return rows.map(map);
}

async function readFinance(database: QueryExecutor): Promise<FinanceResponse> {
  try {
    const [
      invoices,
      paymentRequests,
      payments,
      verifications,
      allocations,
      exceptions,
      replacementLinks,
      requestItems,
      purchaseOrders,
    ] = await Promise.all([
      readRows(database, INVOICE_QUERY, INVOICE_LIMIT, invoice),
      readRows(
        database,
        PAYMENT_REQUEST_QUERY,
        PAYMENT_REQUEST_LIMIT,
        paymentRequest,
      ),
      readRows(database, PAYMENT_QUERY, PAYMENT_LIMIT, payment),
      readRows(
        database,
        VERIFICATION_QUERY,
        VERIFICATION_LIMIT,
        verification,
      ),
      readRows(database, ALLOCATION_QUERY, ALLOCATION_LIMIT, allocation),
      readRows(database, EXCEPTION_QUERY, EXCEPTION_LIMIT, invoiceException),
      readRows(
        database,
        REPLACEMENT_LINK_QUERY,
        REPLACEMENT_LINK_LIMIT,
        replacementLink,
      ),
      readRows(
        database,
        REQUEST_ITEM_QUERY,
        REQUEST_ITEM_LIMIT,
        requestItem,
      ),
      readRows(
        database,
        PURCHASE_ORDER_QUERY,
        PURCHASE_ORDER_LIMIT,
        purchaseOrder,
      ),
    ]);

    return {
      invoices,
      paymentRequests,
      payments,
      verifications,
      allocations,
      exceptions,
      replacementLinks,
      requestItems,
      purchaseOrders,
    };
  } catch (error) {
    if (error instanceof FinanceUnavailableError) throw error;
    throw new FinanceUnavailableError();
  }
}

function assertAllowed(context: FinanceAccessContext): void {
  if (!context.roles.some((role) => ALLOWED_ROLES.has(role))) {
    throw new FinanceForbiddenError();
  }
}

async function auditRead(
  options: FinanceModuleOptions,
  access: FinanceAccessContext,
  request: FastifyRequest,
): Promise<void> {
  try {
    await options.audit({
      access,
      action: "view",
      module: "finance",
      entityType: "finance_dashboard",
      entityId: "latest",
      sensitiveView: true,
      request,
    });
  } catch {
    throw new FinanceUnavailableError();
  }
}

export async function registerFinanceModule(
  app: FastifyInstance,
  options: FinanceModuleOptions,
): Promise<void> {
  if (!app.getSchema(financeSchemaId)) {
    app.addSchema(financeResponseSchema);
  }

  app.get<{ Reply: FinanceResponse }>(
    "/api/v1/finance",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["finance"],
        summary: "Read the company finance workspace",
        response: {
          200: { $ref: `${financeSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      assertAllowed(access);

      if (access.localPreview) {
        return {
          invoices: [],
          paymentRequests: [],
          payments: [],
          verifications: [],
          allocations: [],
          exceptions: [],
          replacementLinks: [],
          requestItems: [],
          purchaseOrders: [],
          preview: true,
        };
      }

      if (options.database === undefined) {
        throw new FinanceUnavailableError();
      }

      const response = await readFinance(options.database);
      await auditRead(options, access, request);
      return response;
    },
  );
}
