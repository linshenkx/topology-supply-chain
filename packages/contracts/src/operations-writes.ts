import { commandHeadersSchema } from "./commands.js";

export const OPERATIONS_COMMANDS = Object.freeze({
  approvalsPost: "approvals.decide",
  inventoryPost: "inventory.reserve",
  transfersPost: "inventory.transfer.request",
  transfersPatch: "inventory.transfer.transition",
  productionOrdersPost: "manufacturing.order.create",
  productionOrdersPatch: "manufacturing.order.transition",
  purchaseReceiptsPost: "purchase.receive",
  qualityInspectionsPost: "quality.inspection.submit",
  stocktakesPost: "inventory.stocktake.open",
  stocktakesPatch: "inventory.stocktake.transition",
  shipmentsPost: "logistics.shipment.command",
  returnsPost: "returns.command",
  financePost: "finance.command",
  warehousesPost: "warehouses.command",
} as const);

export type OperationsCommandName = (typeof OPERATIONS_COMMANDS)[keyof typeof OPERATIONS_COMMANDS];

export const OPERATIONS_COMMAND_RESOURCES: Readonly<Record<OperationsCommandName, string>> = Object.freeze({
  "approvals.decide": "r3.approvals.commands",
  "inventory.reserve": "r3.inventory.commands",
  "inventory.transfer.request": "r3.transfers.commands",
  "inventory.transfer.transition": "r3.transfers.commands",
  "manufacturing.order.create": "r3.production-orders.commands",
  "manufacturing.order.transition": "r3.production-orders.commands",
  "purchase.receive": "r3.purchase-receipts.commands",
  "quality.inspection.submit": "r3.quality-inspections.commands",
  "inventory.stocktake.open": "r3.stocktakes.commands",
  "inventory.stocktake.transition": "r3.stocktakes.commands",
  "logistics.shipment.command": "r3.shipments.commands",
  "returns.command": "r3.returns.commands",
  "finance.command": "r3.finance.commands",
  "warehouses.command": "r3.warehouses.commands",
});

const id = { type: "integer", minimum: 1 } as const;
const text = { type: "string", minLength: 1, maxLength: 1_000 } as const;
const quantity = { type: "integer", minimum: 0 } as const;
const positiveQuantity = { type: "integer", minimum: 1 } as const;
const dateTime = { type: "string", minLength: 1, maxLength: 100 } as const;
const action = (value: string) => ({ const: value } as const);
const object = (required: readonly string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
} as const);

interface ObjectVariant {
  properties: Record<string, unknown>;
  required: readonly string[];
}

function discriminatedObject(variants: readonly ObjectVariant[]) {
  const properties: Record<string, unknown> = {};
  const actions: string[] = [];
  const allOf = variants.map((variant) => {
    Object.assign(properties, variant.properties);
    const actionSchema = variant.properties.action as { const?: unknown } | undefined;
    if (typeof actionSchema?.const !== "string") throw new TypeError("Action variant requires a string const");
    actions.push(actionSchema.const);
    return {
      if: { required: ["action"], properties: { action: { const: actionSchema.const } } },
      then: { required: variant.required },
    } as const;
  });
  properties.action = { enum: actions };
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties,
    allOf,
  } as const;
}

export const operationsCommandHeadersSchema = commandHeadersSchema;

export const approvalDecisionSchema = object(["id", "decision"], {
  id,
  decision: { enum: ["approved", "rejected"] },
  comment: { type: "string", maxLength: 2_000 },
  challengeNo: { type: "string", minLength: 8, maxLength: 191 },
});

export const inventoryReservationSchema = object(
  ["batchId", "entityType", "requestedQuantity"],
  {
    batchId: id,
    entityType: { enum: ["purchase_order", "production_order", "shipment_plan", "historical"] },
    entityId: id,
    requestedQuantity: positiveQuantity,
    priority: { type: "integer", minimum: -1_000, maximum: 1_000 },
  },
);

export const transferRequestSchema = object(
  ["fromWarehouseId", "toWarehouseId", "sku", "quantity", "reason"],
  { fromWarehouseId: id, toWarehouseId: id, sku: text, quantity: positiveQuantity, reason: text },
);

export const transferTransitionSchema = object(["id", "action"], {
  id,
  action: { enum: ["ship", "receive"] },
});

export const productionOrderCreateSchema = object(
  ["orderItemId", "factoryId", "bomId", "plannedQuantity", "plannedStartDate", "plannedFinishDate"],
  {
    orderItemId: id,
    factoryId: id,
    bomId: id,
    plannedQuantity: positiveQuantity,
    dueDate: dateTime,
    plannedStartDate: dateTime,
    plannedFinishDate: dateTime,
  },
);

export const productionOrderTransitionSchema = discriminatedObject([
    object(["id", "action"], { id, action: action("start") }),
    object(["id", "action", "materials"], {
      id,
      action: action("materials"),
      materials: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: object(["id", "issuedQuantity", "consumedQuantity", "lossQuantity"], {
          id, issuedQuantity: quantity, consumedQuantity: quantity, lossQuantity: quantity,
        }),
      },
    }),
    object(["id", "action", "actualFinishedQuantity"], {
      id,
      action: action("complete"),
      actualFinishedQuantity: quantity,
      companyInventoryQuantity: quantity,
      factoryOwnedQuantity: quantity,
      materials: {
        type: "array",
        maxItems: 500,
        items: object(["id", "issuedQuantity", "consumedQuantity", "lossQuantity"], {
          id, issuedQuantity: quantity, consumedQuantity: quantity, lossQuantity: quantity,
        }),
      },
    }),
    object(["id", "action"], { id, action: action("release_materials") }),
]);

export const qualityInspectionSubmitSchema = object(
  ["stage", "inspectionMethod", "batchQuantity", "inspectedQuantity", "passedQuantity", "failedQuantity", "inspectorType"],
  {
    executionOrderId: id,
    batchId: id,
    stage: { enum: ["incoming", "finished_goods"] },
    inspectionMethod: { enum: ["sampling", "full"] },
    batchQuantity: positiveQuantity,
    inspectedQuantity: positiveQuantity,
    passedQuantity: quantity,
    failedQuantity: quantity,
    inspectorType: { enum: ["company_qc", "supplier_qc"] },
    defectReason: { type: "string", maxLength: 2_000 },
    requestedResult: { enum: ["passed", "failed", "conditional"] },
    sourceInspectionId: id,
  },
);

export const purchaseReceiptSchema = object(["purchaseOrderId", "orderItemId", "warehouseId"], {
  purchaseOrderId: id,
  orderItemId: id,
  warehouseId: id,
  receivedQuantity: positiveQuantity,
  receivedAt: dateTime,
});

export const stocktakeOpenSchema = object(["warehouseId", "scope", "dueDate"], {
  warehouseId: id,
  scope: { enum: ["full_warehouse", "sku_sample", "batch"] },
  dueDate: dateTime,
  assignedFactoryId: id,
  skus: { type: "array", maxItems: 1_000, items: text },
  batchIds: { type: "array", maxItems: 1_000, items: id },
});

export const stocktakeTransitionSchema = discriminatedObject([
    object(["id", "action", "sku", "availableQuantity", "lockedQuantity", "defectiveQuantity", "pendingInspectionQuantity"], {
      id, action: action("submit_count"), batchId: id, sku: text,
      availableQuantity: quantity, lockedQuantity: quantity, defectiveQuantity: quantity,
      pendingInspectionQuantity: quantity,
    }),
    object(["id", "action"], {
      id, action: action("finish_round"), estimatedProductionDate: dateTime, estimatedExpiryDate: dateTime,
    }),
]);

export const shipmentCommandSchema = discriminatedObject([
    object(["action", "executionOrderId", "batchNo", "quantity", "plannedShipAt", "destination"], {
      action: action("create"), executionOrderId: id, batchNo: text, quantity: positiveQuantity,
      plannedShipAt: dateTime, destination: text,
    }),
    object(["action", "deliveryBatchId"], { action: action("confirm"), deliveryBatchId: id }),
    object(["action", "deliveryBatchId", "shippedAt", "carrier", "logisticsNo", "evidenceFileId"], {
      action: action("ship"), deliveryBatchId: id, shippedAt: dateTime, carrier: text, logisticsNo: text,
      deviationReason: { type: "string", maxLength: 2_000 }, evidenceFileId: id,
      evidenceFileName: { type: "string", maxLength: 500 },
    }),
    object(["action", "deliveryBatchId", "receivedQuantity", "damagedQuantity", "receivedAt", "receiptEvidenceFileId"], {
      action: action("receive"), deliveryBatchId: id, receivedQuantity: quantity, damagedQuantity: quantity,
      receivedAt: dateTime, receiptEvidenceFileId: id, exceptionReason: { type: "string", maxLength: 2_000 },
    }),
    object(["action", "exceptionId", "resolution"], { action: action("resolve_exception"), exceptionId: id, resolution: text }),
]);

const disposition = object(["type", "quantity"], {
  type: { enum: ["restock", "rework", "scrap"] }, quantity,
});
export const returnCommandSchema = discriminatedObject([
    object(["action", "returnNo", "sourceDeliveryBatchId", "warehouseId", "quantity"], {
      action: action("receive"), returnNo: text, sourceDeliveryBatchId: id, warehouseId: id, quantity: positiveQuantity,
    }),
    object(["action", "productReturnId", "inspectedQuantity", "passedQuantity", "failedQuantity", "evidenceFileId"], {
      action: action("inspect"), productReturnId: id, inspectedQuantity: positiveQuantity,
      passedQuantity: quantity, failedQuantity: quantity, defectReason: { type: "string", maxLength: 2_000 }, evidenceFileId: id,
    }),
    object(["action", "productReturnId", "dispositions"], {
      action: action("propose"), productReturnId: id,
      dispositions: { type: "array", minItems: 1, maxItems: 3, items: disposition },
    }),
    object(["action", "productReturnId", "decision"], {
      action: action("review"), productReturnId: id, decision: { enum: ["approved", "rejected"] },
    }),
]);

export const financeCommandSchema = discriminatedObject([
    object(["action", "factoryId", "purchaseOrderId", "invoiceNo", "invoiceType", "coverageMode", "amountTaxIncludedMinor", "taxAmountMinor", "issuedAt", "fileId"], {
      action: action("create_invoice"), factoryId: id, purchaseOrderId: id, invoiceNo: text, invoiceType: text,
      coverageMode: { enum: ["full_order", "delivery_batch", "order", "shipment"] }, deliveryBatchId: id,
      amountTaxIncludedMinor: positiveQuantity, taxAmountMinor: quantity, expectedAmountMinor: positiveQuantity,
      issuedAt: dateTime, fileId: id,
    }),
    object(["action", "invoiceId", "verifierRole", "decision"], {
      action: action("verify_invoice"), invoiceId: id, verifierRole: { enum: ["supply_chain", "finance"] },
      decision: { enum: ["approved", "rejected"] }, rejectionReason: { type: "string", maxLength: 2_000 },
    }),
    object(["action", "paymentRequestId", "amountMinor", "paidAt", "bankReference", "challengeNo"], {
      action: action("record_payment"), paymentRequestId: id, amountMinor: positiveQuantity,
      paidAt: dateTime, bankReference: text, challengeNo: text,
    }),
    object(["action", "invoiceId", "exceptionType", "reason", "replacementDeadline"], {
      action: action("invalidate_invoice"), invoiceId: id, exceptionType: { enum: ["red_invoice", "voided"] },
      reason: text, replacementDeadline: dateTime,
    }),
    object(["action", "invoiceExceptionId", "replacementInvoiceId", "coveredAmountMinor"], {
      action: action("link_replacement_invoice"), invoiceExceptionId: id, replacementInvoiceId: id, coveredAmountMinor: positiveQuantity,
    }),
    object(["action", "invoiceExceptionId", "paymentRequestId", "amountMinor", "paidAt", "bankReference", "challengeNo"], {
      action: action("record_refund"), invoiceExceptionId: id, paymentRequestId: id, amountMinor: positiveQuantity,
      paidAt: dateTime, bankReference: text, challengeNo: text,
    }),
    object(["action", "paymentRecordId", "reason", "challengeNo"], {
      action: action("request_record_correction"), paymentRecordId: id, reason: text, challengeNo: text,
      proposedPaymentRequestId: id, proposedAmountMinor: positiveQuantity, proposedPaidAt: dateTime, proposedBankReference: text,
    }),
    object(["action", "invoiceExceptionId", "reason", "evidenceFileId", "challengeNo"], {
      action: action("release_invoice_risk"), invoiceExceptionId: id, reason: text, evidenceFileId: id, challengeNo: text,
    }),
]);

export const warehouseCommandSchema = discriminatedObject([
    object(["action", "code", "name", "type"], {
      action: action("create"), code: text, name: text, type: { enum: ["factory", "company", "other"] },
      factoryId: id, address: { type: "string", maxLength: 2_000 },
    }),
    object(["action", "id", "targetId", "reason"], { action: action("request_merge"), id, targetId: id, reason: text }),
    object(["action", "id"], { action: action("deactivate"), id }),
]);

export const operationsCommandResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "result"],
  properties: {
    command: {
      type: "object",
      additionalProperties: false,
      required: ["command", "idempotencyKey", "requestDigest", "replayed"],
      properties: {
        command: { enum: Object.values(OPERATIONS_COMMANDS) },
        idempotencyKey: { type: "string" },
        requestDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        replayed: { type: "boolean" },
      },
    },
    result: { type: "object", additionalProperties: true },
  },
} as const;
