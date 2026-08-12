import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  approvalRequests,
  deliveryBatches,
  exceptions,
  executionOrders,
  factoryPaymentRequestItems,
  factoryPaymentRequests,
  factoryPaymentSchedules,
  factoryPaymentTerms,
  inventoryBatches,
  inventoryMovements,
  orderItems,
  shipmentEvidence,
  shipmentReceipts,
  warehouses,
} from "../../../db/schema";
import { executeAffected, insertOne } from "../../../db/insert-one";
import { withDbTransaction } from "../../../db/transaction";
import {
  accessErrorResponse,
  isInternal,
  requireAccess,
  requireRole,
} from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { calculatePlannedPaymentDate } from "../../lib/business-rules";
import { retiredPlatformRoute } from "../../lib/retired-writer";

function localDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("日期格式不正确。");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function GET() {
  return retiredPlatformRoute("/api/v1/shipments");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/shipments");
  try {
    const access = await requireAccess(request);
    const body = (await request.json()) as {
      action?: "create" | "confirm" | "ship" | "receive" | "resolve_exception";
      deliveryBatchId?: number;
      executionOrderId?: number;
      batchNo?: string;
      quantity?: number;
      plannedShipAt?: string;
      shippedAt?: string;
      carrier?: string;
      logisticsNo?: string;
      destination?: string;
      deviationReason?: string;
      evidenceFileKey?: string;
      evidenceFileName?: string;
      receivedQuantity?: number;
      damagedQuantity?: number;
      receivedAt?: string;
      receiptEvidenceFileKey?: string;
      exceptionReason?: string;
      exceptionId?: number;
    };
    if (body.action === "create") return createShipment(request, access, body);
    if (body.action === "confirm") return confirmShipment(request, access, body);
    if (body.action === "ship") return shipShipment(request, access, body);
    if (body.action === "receive") return receiveShipment(request, access, body);
    if (body.action === "resolve_exception") return resolveShipmentException(request, access, body);
    return Response.json({ error: "不支持的发货操作。" }, { status: 400 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

async function createShipment(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "supply_chain"]);
  const executionOrderId = Number(body.executionOrderId);
  const quantity = Math.trunc(Number(body.quantity));
  const batchNo = String(body.batchNo ?? "").trim();
  const plannedShipAt = String(body.plannedShipAt ?? "");
  const destination = String(body.destination ?? "").trim();
  if (!executionOrderId || quantity <= 0 || !batchNo || !plannedShipAt || !destination) {
    return Response.json({ error: "执行单、批次号、数量、计划发货时间和收货地址不能为空。" }, { status: 400 });
  }
  if (access.localPreview) {
    return Response.json({ shipment: { id: 0, batchNo, status: "pending_factory_confirmation" }, preview: true }, { status: 201 });
  }
  const db = getDb();
  const [order] = await db
    .select()
    .from(executionOrders)
    .where(eq(executionOrders.id, executionOrderId))
    .limit(1);
  if (!order) return Response.json({ error: "执行单不存在。" }, { status: 404 });
  const shipment = await insertOne<typeof deliveryBatches.$inferSelect>(
    db.insert(deliveryBatches).values({
      executionOrderId,
      batchNo,
      quantity,
      plannedShipAt,
      carrier: "",
      logisticsNo: "",
      destination,
      status: "pending_factory_confirmation",
    }),
    id => db.select().from(deliveryBatches).where(eq(deliveryBatches.id, id)).limit(1),
  );
  await writeAudit(access, {
    action: "create",
    module: "shipping",
    entityType: "delivery_batch",
    entityId: shipment.id,
    businessNo: shipment.batchNo,
    after: shipment,
    request,
  });
  return Response.json({ shipment }, { status: 201 });
}

async function confirmShipment(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "factory", "supply_chain"]);
  const id = Number(body.deliveryBatchId);
  if (!id) return Response.json({ error: "发货批次不能为空。" }, { status: 400 });
  if (access.localPreview) return Response.json({ shipment: { id, status: "planned" }, preview: true });
  const db = getDb();
  const [shipment] = await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, id)).limit(1);
  if (!shipment) return Response.json({ error: "发货批次不存在。" }, { status: 404 });
  const [execution] = await db.select().from(executionOrders).where(eq(executionOrders.id, shipment.executionOrderId)).limit(1);
  if (!execution || (!isInternal(access) && execution.factoryId !== access.factoryId)) {
    return Response.json({ error: "无权确认该发货计划。" }, { status: 403 });
  }
  if (shipment.status !== "pending_factory_confirmation") {
    return Response.json({ error: "该计划当前状态无需重复确认。" }, { status: 409 });
  }
  await db.update(deliveryBatches).set({ status: "planned", updatedAt: new Date().toISOString() }).where(eq(deliveryBatches.id, id));
  await writeAudit(access, { action: "confirm", module: "shipping", entityType: "delivery_batch", entityId: id, businessNo: shipment.batchNo, before: shipment, after: { ...shipment, status: "planned" }, request });
  return Response.json({ shipment: { ...shipment, status: "planned" } });
}

async function shipShipment(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "factory", "supply_chain"]);
  const id = Number(body.deliveryBatchId);
  const shippedAt = String(body.shippedAt ?? "");
  const carrier = String(body.carrier ?? "").trim();
  const logisticsNo = String(body.logisticsNo ?? "").trim();
  const evidenceFileKey = String(body.evidenceFileKey ?? "").trim();
  if (!id || !shippedAt || !carrier || !logisticsNo || !evidenceFileKey) {
    return Response.json({ error: "实际发货时间、承运商、物流单号和发货凭证均为必填项。" }, { status: 400 });
  }
  if (access.localPreview) {
    return Response.json({ shipment: { id, status: "shipped", shippedAt }, preview: true });
  }
  const db = getDb();
  const [shipment] = await db
    .select()
    .from(deliveryBatches)
    .where(eq(deliveryBatches.id, id))
    .limit(1);
  if (!shipment) return Response.json({ error: "发货批次不存在。" }, { status: 404 });
  const [execution] = await db
    .select()
    .from(executionOrders)
    .where(eq(executionOrders.id, shipment.executionOrderId))
    .limit(1);
  if (shipment.status === "pending_factory_confirmation") {
    return Response.json({ error: "组装工厂尚未确认发货计划，暂不能发货。" }, { status: 409 });
  }
  if (!execution) return Response.json({ error: "执行单不存在。" }, { status: 404 });
  if (!isInternal(access) && execution.factoryId !== access.factoryId) {
    return Response.json({ error: "无权操作该发货批次。" }, { status: 403 });
  }
  if (shipment.status === "shipped" || shipment.status === "received") {
    return Response.json({ error: "该批次已经实际发货，不能重复扣减库存。" }, { status: 409 });
  }
  const sameDay = localDate(shipment.plannedShipAt) === localDate(shippedAt);
  if (!sameDay && shipment.status !== "approved_to_ship") {
    const reason = String(body.deviationReason ?? "").trim();
    if (!reason) return Response.json({ error: "未按计划日期发货必须填写偏离原因。" }, { status: 400 });
    const existing = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.workflowType, "shipment_deviation"),
          eq(approvalRequests.entityId, shipment.id),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (!existing.length) {
      await db.insert(approvalRequests).values({
        requestNo: `AP-SHIP-${Date.now()}`,
        workflowType: "shipment_deviation",
        entityType: "delivery_batch",
        entityId: shipment.id,
        summary: `${shipment.batchNo}未按计划日期发货`,
        payloadJson: JSON.stringify({ plannedShipAt: shipment.plannedShipAt, shippedAt, reason }),
        requestedBy: access.userId,
      });
    }
    await db
      .update(deliveryBatches)
      .set({
        requiresApproval: true,
        deviationReason: reason,
        status: "pending_supply_chain",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(deliveryBatches.id, shipment.id));
    return Response.json(
      { approvalRequired: true, message: "实际发货日期与计划日期不同，已提交供应链审批，暂未扣减库存。" },
      { status: 202 },
    );
  }

  const [item] = await db
    .select({
      sku: orderItems.sku,
      purchaseOrderId: orderItems.purchaseOrderId,
      unitPriceTaxIncludedMinor: orderItems.unitPriceTaxIncludedMinor,
    })
    .from(orderItems)
    .where(eq(orderItems.id, execution.orderItemId))
    .limit(1);
  if (!item) return Response.json({ error: "采购单明细不存在。" }, { status: 404 });
  const factoryWarehouses = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.factoryId, execution.factoryId), eq(warehouses.status, "active")));
  const warehouseIds = factoryWarehouses.map((row) => row.id);
  if (!warehouseIds.length) return Response.json({ error: "组装工厂没有可用仓库。" }, { status: 409 });
  const batches = await db
    .select()
    .from(inventoryBatches)
    .where(
      and(
        inArray(inventoryBatches.warehouseId, warehouseIds),
        eq(inventoryBatches.sku, item.sku),
        eq(inventoryBatches.ownership, "company"),
        gt(inventoryBatches.availableQuantity, 0),
      ),
    )
    .orderBy(asc(inventoryBatches.expiryDate), asc(inventoryBatches.inboundDate));
  const available = batches.reduce((sum, batch) => sum + batch.availableQuantity, 0);
  if (available < shipment.quantity) {
    return Response.json(
      { error: "可用库存不足，禁止发货。", availableQuantity: available, requiredQuantity: shipment.quantity },
      { status: 409 },
    );
  }

  const payment = await withDbTransaction(db, async tx => {
    let remaining = shipment.quantity;
    for (const batch of batches) {
      if (!remaining) break;
      const quantity = Math.min(remaining, batch.availableQuantity);
      const updated = await executeAffected(tx
        .update(inventoryBatches)
        .set({
          availableQuantity: sql`${inventoryBatches.availableQuantity} - ${quantity}`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(inventoryBatches.id, batch.id),
            gt(inventoryBatches.availableQuantity, quantity - 1),
          ),
        ));
      if (!updated) throw new Error("库存发生并发变化，请重新提交发货。");
      await tx.insert(inventoryMovements).values({
        warehouseId: batch.warehouseId,
        sku: item.sku,
        type: "shipment",
        quantity: -quantity,
        deliveryBatchId: shipment.id,
        occurredAt: shippedAt,
        createdBy: access.userId,
      });
      remaining -= quantity;
    }
    await tx.insert(shipmentEvidence).values({
      deliveryBatchId: shipment.id,
      fileKey: evidenceFileKey,
      fileName: String(body.evidenceFileName ?? "发货凭证"),
    });
    await tx
      .update(deliveryBatches)
      .set({
        shippedAt,
        carrier,
        logisticsNo,
        status: "shipped",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(deliveryBatches.id, shipment.id));
    return createPaymentRequestForShipment({
      db: tx,
      access,
      shipment: { ...shipment, shippedAt },
      execution,
      purchaseOrderId: item.purchaseOrderId,
      unitPriceMinor: item.unitPriceTaxIncludedMinor,
    });
  });
  await writeAudit(access, {
    action: "ship",
    module: "shipping",
    entityType: "delivery_batch",
    entityId: shipment.id,
    businessNo: shipment.batchNo,
    before: shipment,
    after: { shippedAt, carrier, logisticsNo, quantity: shipment.quantity },
    request,
  });
  return Response.json({
    success: true,
    deductedQuantity: shipment.quantity,
    paymentRequest: payment.request,
    warning: payment.warning,
  });
}

async function receiveShipment(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "receiver"]);
  const id = Number(body.deliveryBatchId);
  const receivedQuantity = Math.trunc(Number(body.receivedQuantity));
  const damagedQuantity = Math.trunc(Number(body.damagedQuantity ?? 0));
  const receivedAt = String(body.receivedAt ?? "");
  const evidenceFileKey = String(body.receiptEvidenceFileKey ?? "").trim();
  if (!id || receivedQuantity < 0 || damagedQuantity < 0 || !receivedAt || !evidenceFileKey) {
    return Response.json({ error: "签收数量、签收时间和签收凭证不能为空。" }, { status: 400 });
  }
  if (access.localPreview) return Response.json({ receipt: { id: 0 }, preview: true }, { status: 201 });
  const db = getDb();
  const [shipment] = await db.select().from(deliveryBatches).where(eq(deliveryBatches.id, id)).limit(1);
  if (!shipment) return Response.json({ error: "发货批次不存在。" }, { status: 404 });
  if (shipment.status !== "shipped") return Response.json({ error: "只有已发货批次可以签收。" }, { status: 409 });
  if (
    access.roles.includes("receiver") &&
    (!access.organizationName ||
      shipment.destination.trim() !== access.organizationName.trim())
  ) {
    return Response.json({ error: "无权签收其他收货方的发货批次。" }, { status: 403 });
  }
  const hasException = receivedQuantity < shipment.quantity || damagedQuantity > 0;
  const reason = String(body.exceptionReason ?? "").trim();
  if (hasException && !reason) {
    return Response.json({ error: "少货或破损时必须填写原因并上传现场照片。" }, { status: 400 });
  }
  const receipt = await insertOne<typeof shipmentReceipts.$inferSelect>(
    db.insert(shipmentReceipts).values({
      deliveryBatchId: shipment.id,
      receivedQuantity,
      damagedQuantity,
      receivedAt,
      evidenceFileKey,
      exceptionReason: reason,
      receivedBy: access.userId,
    }),
    receiptId => db.select().from(shipmentReceipts).where(eq(shipmentReceipts.id, receiptId)).limit(1),
  );
  if (hasException) {
    await db.insert(exceptions).values({
      executionOrderId: shipment.executionOrderId,
      type: "logistics_exception",
      description: `${shipment.batchNo}签收异常：发出${shipment.quantity}，签收${receivedQuantity}，破损${damagedQuantity}。${reason}`,
      evidenceFileKey,
      status: "pending_supply_chain",
      submittedBy: access.userId,
    });
  }
  await db
    .update(deliveryBatches)
    .set({ status: hasException ? "received_with_exception" : "received", updatedAt: new Date().toISOString() })
    .where(eq(deliveryBatches.id, shipment.id));
  await writeAudit(access, {
    action: "receive",
    module: "shipping",
    entityType: "shipment_receipt",
    entityId: receipt.id,
    businessNo: shipment.batchNo,
    after: { ...receipt, hasException },
    request,
  });
  return Response.json({ receipt, logisticsExceptionCreated: hasException }, { status: 201 });
}

async function resolveShipmentException(
  request: Request,
  access: Awaited<ReturnType<typeof requireAccess>>,
  body: Record<string, unknown>,
) {
  requireRole(access, ["admin", "supply_chain"]);
  const id = Number(body.exceptionId);
  const resolution = String(body.resolution ?? "").trim();
  if (!id || !resolution) return Response.json({ error: "异常和处理结果不能为空。" }, { status: 400 });
  if (access.localPreview) return Response.json({ exception: { id, status: "resolved" }, preview: true });
  const db = getDb();
  const [record] = await db.select().from(exceptions).where(eq(exceptions.id, id)).limit(1);
  if (!record || record.type !== "logistics_exception") return Response.json({ error: "物流异常不存在。" }, { status: 404 });
  if (record.status === "resolved") return Response.json({ error: "该异常已经关闭。" }, { status: 409 });
  const now = new Date().toISOString();
  await db.update(exceptions).set({ status: "resolved", updatedAt: now }).where(eq(exceptions.id, id));
  await writeAudit(access, { action: "resolve", module: "shipping", entityType: "logistics_exception", entityId: id, before: record, after: { ...record, status: "resolved", resolution }, request });
  return Response.json({ exception: { ...record, status: "resolved", resolution } });
}

async function createPaymentRequestForShipment(input: {
  db: ReturnType<typeof getDb>;
  access: Awaited<ReturnType<typeof requireAccess>>;
  shipment: typeof deliveryBatches.$inferSelect;
  execution: typeof executionOrders.$inferSelect;
  purchaseOrderId: number;
  unitPriceMinor: number;
}) {
  const db = input.db;
  const [term] = await db
    .select()
    .from(factoryPaymentTerms)
    .where(
      and(
        eq(factoryPaymentTerms.factoryId, input.execution.factoryId),
        eq(factoryPaymentTerms.active, true),
      ),
    )
    .orderBy(desc(factoryPaymentTerms.createdAt))
    .limit(1);
  if (!term) {
    return {
      request: null,
      warning: "该组装工厂尚未配置付款条件，发货已完成，请供应链补充付款条件后生成请款。",
    };
  }
  const shippedAt = input.shipment.shippedAt!;
  const plannedPaymentDate = calculatePlannedPaymentDate({
    shippedAt,
    mode: term.mode,
    daysAfterShipment: term.daysAfterShipment,
    cutoffDay: term.cutoffDay,
    paymentDay: term.paymentDay,
  });
  const amountMinor = input.shipment.quantity * input.unitPriceMinor;
  const schedule = await insertOne<typeof factoryPaymentSchedules.$inferSelect>(
    db.insert(factoryPaymentSchedules).values({
      purchaseOrderId: input.purchaseOrderId,
      factoryId: input.execution.factoryId,
      deliveryBatchId: input.shipment.id,
      paymentType: "balance",
      shippedQuantity: input.shipment.quantity,
      unitPriceMinor: input.unitPriceMinor,
      amountMinor,
      paymentTermId: term.id,
      paymentRuleSnapshot: JSON.stringify({
        name: term.name,
        mode: term.mode,
        daysAfterShipment: term.daysAfterShipment,
        cutoffDay: term.cutoffDay,
        paymentDay: term.paymentDay,
      }),
      plannedPaymentDate,
      maintainedBy: input.access.userId,
      status: "requested",
    }),
    id => db.select().from(factoryPaymentSchedules).where(eq(factoryPaymentSchedules.id, id)).limit(1),
  );
  let [request] = await db
    .select()
    .from(factoryPaymentRequests)
    .where(
      and(
        eq(factoryPaymentRequests.factoryId, input.execution.factoryId),
        eq(factoryPaymentRequests.plannedPaymentDate, plannedPaymentDate),
      ),
    )
    .limit(1);
  if (request) {
    await db
      .update(factoryPaymentRequests)
      .set({
        totalAmountMinor: sql`${factoryPaymentRequests.totalAmountMinor} + ${amountMinor}`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(factoryPaymentRequests.id, request.id));
    [request] = await db.select().from(factoryPaymentRequests).where(eq(factoryPaymentRequests.id, request.id)).limit(1);
  } else {
    request = await insertOne<typeof factoryPaymentRequests.$inferSelect>(
      db.insert(factoryPaymentRequests).values({
        requestNo: `PAY-${plannedPaymentDate.replaceAll("-", "")}-${input.execution.factoryId}`,
        factoryId: input.execution.factoryId,
        actualShipmentDate: shippedAt.slice(0, 10),
        plannedPaymentDate,
        totalAmountMinor: amountMinor,
        status: "waiting_invoice",
        maintainedBy: input.access.userId,
      }),
      id => db.select().from(factoryPaymentRequests).where(eq(factoryPaymentRequests.id, id)).limit(1),
    );
  }
  await db.insert(factoryPaymentRequestItems).values({
    paymentRequestId: request.id,
    paymentScheduleId: schedule.id,
    purchaseOrderId: input.purchaseOrderId,
    triggeredByDeliveryBatchId: input.shipment.id,
    amountMinor,
  });
  return { request, warning: null };
}
