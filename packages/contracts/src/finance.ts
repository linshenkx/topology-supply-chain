export const financeSchemaId = "Finance";

export type FinancePaymentRequestStatus =
  | "waiting_invoice"
  | "generated"
  | "submitted_to_finance"
  | "paid"
  | "partially_paid"
  | "invoice_exception_frozen"
  | "failed"
  | "cancelled";

export interface FinancePaymentRequest {
  id: number;
  requestNo: string;
  factoryId: number;
  plannedPaymentDate: string;
  totalAmountMinor: number;
  invoiceCoveredAmountMinor: number;
  status: FinancePaymentRequestStatus;
}

export type FinanceInvoiceStatus =
  | "pending"
  | "received"
  | "verified"
  | "rejected"
  | "invalidated";

export interface FinanceInvoice {
  id: number;
  invoiceNo: string;
  purchaseOrderId: number;
  amountTaxIncludedMinor: number;
  expectedAmountMinor: number;
  amountMatchesExpected: boolean;
  status: FinanceInvoiceStatus;
  issuedAt: string;
}

export interface FinancePaymentRecord {
  id: number;
  paymentRequestId: number;
  amountMinor: number;
  paidAt: string;
  bankReference: string;
  recordType: "payment" | "reversal" | "correction" | "refund";
  invoiceExceptionId: number | null;
}

export interface FinanceInvoiceVerification {
  id: number;
  invoiceId: number;
  verifierRole: "supply_chain" | "finance";
  decision: "approved" | "rejected";
  rejectionReason: string | null;
}

export interface FinanceInvoicePaymentAllocation {
  id: number;
  invoiceId: number;
  paymentRequestId: number;
  allocatedAmountMinor: number;
  status: "active" | "frozen" | "released";
}

export interface FinanceInvoiceException {
  id: number;
  invoiceId: number;
  exceptionType: "red_invoice" | "voided";
  affectedAmountMinor: number;
  replacementDeadline: string;
  replacementCoveredAmountMinor: number;
  refundedAmountMinor: number;
  status: "awaiting_remediation" | "risk_warning" | "resolved";
  reason: string;
}

export interface FinanceReplacementInvoiceLink {
  id: number;
  invoiceExceptionId: number;
  replacementInvoiceId: number;
  coveredAmountMinor: number;
  status: "pending_verification" | "verified" | "rejected";
}

export interface FinancePaymentRequestItem {
  id: number;
  paymentRequestId: number;
  paymentScheduleId: number;
  purchaseOrderId: number;
  triggeredByDeliveryBatchId: number;
  amountMinor: number;
}

export interface FinancePurchaseOrder {
  id: number;
  orderNo: string;
  totalTaxIncludedMinor: number;
}

export interface FinanceResponse {
  invoices: FinanceInvoice[];
  paymentRequests: FinancePaymentRequest[];
  payments: FinancePaymentRecord[];
  verifications: FinanceInvoiceVerification[];
  allocations: FinanceInvoicePaymentAllocation[];
  exceptions: FinanceInvoiceException[];
  replacementLinks: FinanceReplacementInvoiceLink[];
  requestItems: FinancePaymentRequestItem[];
  purchaseOrders: FinancePurchaseOrder[];
  preview?: true;
}

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const integerSchema = { type: "integer" } as const;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const;
const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const nullablePositiveIntegerSchema = {
  anyOf: [positiveIntegerSchema, { type: "null" }],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;

export const financeResponseSchema = {
  $id: financeSchemaId,
  type: "object",
  additionalProperties: false,
  required: [
    "invoices",
    "paymentRequests",
    "payments",
    "verifications",
    "allocations",
    "exceptions",
    "replacementLinks",
    "requestItems",
    "purchaseOrders",
  ],
  properties: {
    invoices: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "invoiceNo",
          "purchaseOrderId",
          "amountTaxIncludedMinor",
          "expectedAmountMinor",
          "amountMatchesExpected",
          "status",
          "issuedAt",
        ],
        properties: {
          id: positiveIntegerSchema,
          invoiceNo: nonEmptyStringSchema,
          purchaseOrderId: positiveIntegerSchema,
          amountTaxIncludedMinor: nonNegativeIntegerSchema,
          expectedAmountMinor: nonNegativeIntegerSchema,
          amountMatchesExpected: { type: "boolean" },
          status: {
            type: "string",
            enum: ["pending", "received", "verified", "rejected", "invalidated"],
          },
          issuedAt: nonEmptyStringSchema,
        },
      },
    },
    paymentRequests: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "requestNo",
          "factoryId",
          "plannedPaymentDate",
          "totalAmountMinor",
          "invoiceCoveredAmountMinor",
          "status",
        ],
        properties: {
          id: positiveIntegerSchema,
          requestNo: nonEmptyStringSchema,
          factoryId: positiveIntegerSchema,
          plannedPaymentDate: nonEmptyStringSchema,
          totalAmountMinor: nonNegativeIntegerSchema,
          invoiceCoveredAmountMinor: nonNegativeIntegerSchema,
          status: {
            type: "string",
            enum: [
              "waiting_invoice",
              "generated",
              "submitted_to_finance",
              "paid",
              "partially_paid",
              "invoice_exception_frozen",
              "failed",
              "cancelled",
            ],
          },
        },
      },
    },
    payments: {
      type: "array",
      maxItems: 300,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "paymentRequestId",
          "amountMinor",
          "paidAt",
          "bankReference",
          "recordType",
          "invoiceExceptionId",
        ],
        properties: {
          id: positiveIntegerSchema,
          paymentRequestId: positiveIntegerSchema,
          amountMinor: integerSchema,
          paidAt: nonEmptyStringSchema,
          bankReference: nonEmptyStringSchema,
          recordType: {
            type: "string",
            enum: ["payment", "reversal", "correction", "refund"],
          },
          invoiceExceptionId: nullablePositiveIntegerSchema,
        },
      },
    },
    verifications: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "invoiceId",
          "verifierRole",
          "decision",
          "rejectionReason",
        ],
        properties: {
          id: positiveIntegerSchema,
          invoiceId: positiveIntegerSchema,
          verifierRole: {
            type: "string",
            enum: ["supply_chain", "finance"],
          },
          decision: { type: "string", enum: ["approved", "rejected"] },
          rejectionReason: nullableStringSchema,
        },
      },
    },
    allocations: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "invoiceId",
          "paymentRequestId",
          "allocatedAmountMinor",
          "status",
        ],
        properties: {
          id: positiveIntegerSchema,
          invoiceId: positiveIntegerSchema,
          paymentRequestId: positiveIntegerSchema,
          allocatedAmountMinor: nonNegativeIntegerSchema,
          status: { type: "string", enum: ["active", "frozen", "released"] },
        },
      },
    },
    exceptions: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "invoiceId",
          "exceptionType",
          "affectedAmountMinor",
          "replacementDeadline",
          "replacementCoveredAmountMinor",
          "refundedAmountMinor",
          "status",
          "reason",
        ],
        properties: {
          id: positiveIntegerSchema,
          invoiceId: positiveIntegerSchema,
          exceptionType: { type: "string", enum: ["red_invoice", "voided"] },
          affectedAmountMinor: nonNegativeIntegerSchema,
          replacementDeadline: nonEmptyStringSchema,
          replacementCoveredAmountMinor: nonNegativeIntegerSchema,
          refundedAmountMinor: nonNegativeIntegerSchema,
          status: {
            type: "string",
            enum: ["awaiting_remediation", "risk_warning", "resolved"],
          },
          reason: nonEmptyStringSchema,
        },
      },
    },
    replacementLinks: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "invoiceExceptionId",
          "replacementInvoiceId",
          "coveredAmountMinor",
          "status",
        ],
        properties: {
          id: positiveIntegerSchema,
          invoiceExceptionId: positiveIntegerSchema,
          replacementInvoiceId: positiveIntegerSchema,
          coveredAmountMinor: nonNegativeIntegerSchema,
          status: {
            type: "string",
            enum: ["pending_verification", "verified", "rejected"],
          },
        },
      },
    },
    requestItems: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "paymentRequestId",
          "paymentScheduleId",
          "purchaseOrderId",
          "triggeredByDeliveryBatchId",
          "amountMinor",
        ],
        properties: {
          id: positiveIntegerSchema,
          paymentRequestId: positiveIntegerSchema,
          paymentScheduleId: positiveIntegerSchema,
          purchaseOrderId: positiveIntegerSchema,
          triggeredByDeliveryBatchId: positiveIntegerSchema,
          amountMinor: nonNegativeIntegerSchema,
        },
      },
    },
    purchaseOrders: {
      type: "array",
      maxItems: 300,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "orderNo", "totalTaxIncludedMinor"],
        properties: {
          id: positiveIntegerSchema,
          orderNo: nonEmptyStringSchema,
          totalTaxIncludedMinor: nonNegativeIntegerSchema,
        },
      },
    },
    preview: { const: true },
  },
} as const;
