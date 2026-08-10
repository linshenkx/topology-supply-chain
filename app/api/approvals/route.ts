import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { executeAffected } from "../../../db/insert-one";
import { approvalRequests, corePriceAgreements, corePriceChangeRequests, deliveryBatches, executionOrders, factoryPaymentRequests, factoryPlanResponses, inventoryBatches, inventoryMovements, inventoryTransfers, invoiceExceptions, orderItems, paymentRecords, productionMaterialLines, productionReports, productBoms, purchaseOrders, purchasePlanItems, purchasePlans, reminderSchedules, skus, stocktakeAdjustments, stocktakeCounts, stocktakes, supplierSkus, suppliers, userRoles, warehouses } from "../../../db/schema";
import { AccessError, accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { assertProductionWarehouse, finalizeProductionInventory } from "../../lib/production-finalization";
import { createReminder } from "../../lib/reminders";
import { withDbTransaction } from "../../../db/transaction";
import { consumeVerifiedStepUp } from "../../lib/step-up";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "finance"]);
    if (access.localPreview) return Response.json({ approvals: [], preview: true });
    const rows = await getDb().select().from(approvalRequests).orderBy(desc(approvalRequests.requestedAt)).limit(100);
    await writeAudit(access, { action: "view", module: "approvals", entityType: "approval_list", entityId: "latest", request });
    return Response.json({ approvals: rows });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "finance"]);
    const body = await request.json() as { id?: number; decision?: "approved" | "rejected"; comment?: string; challengeNo?: string };
    if (!body.id || !["approved", "rejected"].includes(body.decision ?? "")) {
      return Response.json({ error: "审批单和审批决定不能为空。" }, { status: 400 });
    }
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb();
    const [approval] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, body.id)).limit(1);
    if (!approval) return Response.json({ error: "审批单不存在。" }, { status: 404 });
    if (approval.workflowType === "user_role_change" && !access.roles.includes("admin")) {
      return Response.json({ error: "用户角色变更只能由另一位管理员审核。" }, { status: 403 });
    }
    if (approval.workflowType === "financial_record_correction" && !access.roles.some((role) => ["admin", "finance"].includes(role))) {
      return Response.json({ error: "财务记录更正只能由另一位财务同事审核。" }, { status: 403 });
    }
    if (approval.workflowType === "production_variance" && !access.roles.some((role) => ["admin", "supply_chain"].includes(role))) {
      return Response.json({ error: "生产偏差只能由供应链同事审核。" }, { status: 403 });
    }
    if (["warehouse_transfer", "warehouse_merge"].includes(approval.workflowType) && !access.roles.some((role) => ["admin", "supply_chain"].includes(role))) {
      return Response.json({ error: "仓库调拨或合并只能由供应链同事审核。" }, { status: 403 });
    }
    if (["sku_verification", "bom_version", "supplier_sku_change", "supplier_price_change"].includes(approval.workflowType) && !access.roles.some((role) => ["admin", "supply_chain"].includes(role))) {
      return Response.json({ error: "SKU和BOM只能由另一位供应链同事审核。" }, { status: 403 });
    }
    if (approval.requestedBy === access.userId) return Response.json({ error: "发起人不能审核本人提交的事项。" }, { status: 409 });
    if (approval.status !== "pending") return Response.json({ error: "该审批单已经处理。" }, { status: 409 });
    if (approval.workflowType === "stocktake_variance" && !access.roles.some((role) => ["admin", "supply_chain"].includes(role))) {
      return Response.json({ error: "盘点差异只能由供应链同事审核。" }, { status: 403 });
    }
    const now = new Date().toISOString();
    const approvalUpdate = {
      status: body.decision!,
      reviewedBy: access.userId,
      reviewedAt: now,
      reviewComment: body.comment?.trim() ?? "",
      smsVerifiedAt: approval.highRisk ? now : null,
      updatedAt: now,
    };
    const correctionApproval = approval.workflowType === "financial_record_correction" && body.decision === "approved";
    const claimApproval = async (tx: typeof db) => {
      if (approval.highRisk) {
        await consumeVerifiedStepUp(tx, {
          challengeNo: body.challengeNo,
          userId: access.userId,
          localPreview: false,
          scope: `approval:${approval.id}`,
        });
      }
      const claimed = await executeAffected(tx.update(approvalRequests)
        .set(approvalUpdate)
        .where(and(
          eq(approvalRequests.id, approval.id),
          eq(approvalRequests.status, "pending"),
        )));
      if (claimed !== 1) throw new AccessError(409, "该审批单已经处理。");
    };
    if (!correctionApproval) {
      await withDbTransaction(db, claimApproval);
    }
    if (approval.workflowType === "supplier_onboarding") {
      await db.update(suppliers).set({
        verificationStatus: body.decision === "approved" ? "approved" : "rejected",
        status: body.decision === "approved" ? "active" : "draft",
        verifiedBy: access.userId,
        verifiedAt: now,
        updatedAt: now,
      }).where(eq(suppliers.id, approval.entityId));
    }
    if (approval.workflowType === "supplier_sku_change") {
      const [relation] = await db.select().from(supplierSkus).where(eq(supplierSkus.id, Number(approval.entityId))).limit(1);
      if (!relation) return Response.json({ error: "待审核的供货关系不存在。" }, { status: 404 });
      if (body.decision === "approved" && relation.isPrimary) {
        const sameSku = await db.select().from(supplierSkus).where(and(eq(supplierSkus.factoryId, relation.factoryId), eq(supplierSkus.sku, relation.sku)));
        for (const row of sameSku.filter(item => item.id !== relation.id && item.isPrimary)) {
          await db.update(supplierSkus).set({ isPrimary: false, updatedAt: now }).where(eq(supplierSkus.id, row.id));
        }
      }
      await db.update(supplierSkus).set({
        status: body.decision === "approved" ? "active" : "inactive",
        reviewedBy: access.userId, reviewedAt: now, updatedAt: now,
      }).where(eq(supplierSkus.id, relation.id));
    }
    if (approval.workflowType === "supplier_price_change") {
      const [change] = await db.select().from(corePriceChangeRequests).where(eq(corePriceChangeRequests.id, Number(approval.entityId))).limit(1);
      if (!change) return Response.json({ error: "待审核的供应商价格变更不存在。" }, { status: 404 });
      if (body.decision === "approved") {
        if (change.currentAgreementId) {
          const start = new Date(`${change.proposedEffectiveFrom}T00:00:00Z`);
          start.setUTCDate(start.getUTCDate() - 1);
          await db.update(corePriceAgreements).set({ effectiveTo: start.toISOString().slice(0, 10), status: "inactive", updatedAt: now }).where(eq(corePriceAgreements.id, change.currentAgreementId));
        }
        await db.insert(corePriceAgreements).values({ supplierId: change.supplierId, sku: change.sku, currency: "CNY", unitPriceTaxIncludedMinor: change.proposedTaxIncludedMinor, unitPriceTaxExcludedMinor: change.proposedTaxExcludedMinor, taxRateBps: change.proposedTaxRateBps, effectiveFrom: change.proposedEffectiveFrom, maintainedBy: change.requestedBy });
      }
      await db.update(corePriceChangeRequests).set({ decision: body.decision!, reviewedBy: access.userId, reviewComment: body.comment?.trim() ?? "", reviewedAt: now, updatedAt: now }).where(eq(corePriceChangeRequests.id, change.id));
    }
    if (approval.workflowType === "sku_verification") {
      await db.update(skus).set({
        verificationStatus: body.decision === "approved" ? "approved" : "rejected",
        status: body.decision === "approved" ? "active" : "draft", updatedAt: now,
      }).where(eq(skus.id, Number(approval.entityId)));
    }
      if (approval.workflowType === "bom_version") {
        const payload = JSON.parse(approval.payloadJson || "{}") as { retireBomIds?: number[]; retirementDate?: string };
        if (body.decision === "approved" && payload.retirementDate) {
          for (const bomId of payload.retireBomIds ?? []) {
            await db.update(productBoms).set({ effectiveTo: payload.retirementDate, updatedAt: now }).where(eq(productBoms.id, bomId));
          }
        }
        await db.update(productBoms).set({
        approvalStatus: body.decision === "approved" ? "approved" : "rejected",
        active: body.decision === "approved", reviewedBy: access.userId, reviewedAt: now, updatedAt: now,
      }).where(eq(productBoms.id, Number(approval.entityId)));
    }
    if (approval.workflowType === "purchase_plan_version") {
      const confirmationDueAt = body.decision === "approved" ? new Date(Date.now() + 3 * 86400000).toISOString() : null;
      await db.update(purchasePlans).set({
        status: body.decision === "approved" ? "awaiting_factory_confirmation" : "draft",
        confirmationDueAt,
        reviewedBy: access.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(purchasePlans.id, approval.entityId));
      if (confirmationDueAt) await createReminder({
        reminderType: "purchase_plan_confirmation", entityType: "purchase_plan", entityId: approval.entityId,
        businessNo: approval.requestNo, dueAt: confirmationDueAt, nextRunAt: confirmationDueAt,
        recurrence: "daily_overdue", recipientRoles: ["factory", "supply_chain"], severity: "approval",
      });
    }
    if (approval.workflowType === "purchase_plan_deviation") {
      const payload = JSON.parse(approval.payloadJson) as Array<{ planItemId?: number }>;
      if (body.decision === "approved") {
        for (const row of payload) if (row.planItemId) {
          await db.update(purchasePlanItems).set({ completionStatus: "exception_approved", updatedAt: now }).where(eq(purchasePlanItems.id, row.planItemId));
        }
      }
      if (approval.entityType === "purchase_order") {
        await db.update(purchaseOrders).set({ status: body.decision === "approved" ? "factory_confirmation" : "approval_rejected", updatedAt: now }).where(eq(purchaseOrders.id, approval.entityId));
      }
      const affected = new Set<number>();
      for (const row of payload) if (row.planItemId) {
        const [item] = await db.select().from(purchasePlanItems).where(eq(purchasePlanItems.id, row.planItemId)).limit(1);
        if (item) affected.add(item.purchasePlanId);
      }
      if (approval.entityType === "purchase_plan") affected.add(approval.entityId);
      for (const planId of affected) {
        const rows = await db.select().from(purchasePlanItems).where(eq(purchasePlanItems.purchasePlanId, planId));
        const complete = rows.every(row => ["within_tolerance", "exception_approved"].includes(row.completionStatus));
        await db.update(purchasePlans).set({ status: complete ? "ordered_complete" : "ordering", updatedAt: now }).where(eq(purchasePlans.id, planId));
      }
    }
    if (approval.workflowType === "purchase_plan_factory_exception") {
      if (!access.roles.some(role => ["admin", "supply_chain"].includes(role))) {
        return Response.json({ error: "工厂计划异议只能由供应链同事审核。" }, { status: 403 });
      }
      const [factoryResponse] = await db.select().from(factoryPlanResponses)
        .where(eq(factoryPlanResponses.id, Number(approval.entityId))).limit(1);
      if (!factoryResponse) return Response.json({ error: "待审核的工厂计划回复不存在。" }, { status: 404 });
      await db.update(factoryPlanResponses).set({
        status: body.decision === "approved" ? "approved" : "rejected",
        reviewedBy: access.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(factoryPlanResponses.id, factoryResponse.id));
      if (body.decision === "approved") {
        if (factoryResponse.proposedArrivalDate) {
          const planItems = await db.select().from(purchasePlanItems)
            .where(eq(purchasePlanItems.purchasePlanId, factoryResponse.purchasePlanId));
          for (const item of planItems.filter(row => row.factoryId === factoryResponse.factoryId)) {
            await db.update(purchasePlanItems).set({
              expectedArrivalDate: factoryResponse.proposedArrivalDate,
              updatedAt: now,
            }).where(eq(purchasePlanItems.id, item.id));
          }
        }
        await db.update(purchasePlans).set({
          status: "confirmed",
          confirmedAt: now,
          reviewedBy: access.userId,
          reviewedAt: now,
          updatedAt: now,
        }).where(eq(purchasePlans.id, factoryResponse.purchasePlanId));
      } else {
        const confirmationDueAt = new Date(Date.now() + 3 * 86400000).toISOString();
        await db.update(purchasePlans).set({
          status: "awaiting_factory_confirmation",
          confirmationDueAt,
          confirmedAt: null,
          reviewedBy: access.userId,
          reviewedAt: now,
          updatedAt: now,
        }).where(eq(purchasePlans.id, factoryResponse.purchasePlanId));
        await createReminder({
          reminderType: "purchase_plan_confirmation",
          entityType: "purchase_plan",
          entityId: factoryResponse.purchasePlanId,
          businessNo: approval.requestNo,
          dueAt: confirmationDueAt,
          nextRunAt: confirmationDueAt,
          recurrence: "daily_overdue",
          recipientRoles: ["factory", "supply_chain"],
          severity: "approval",
        });
      }
    }
    if (approval.workflowType === "purchase_order_factory_exception") {
      if (!access.roles.some(role => ["admin", "supply_chain"].includes(role))) {
        return Response.json({ error: "采购单交货异议只能由供应链同事审核。" }, { status: 403 });
      }
      const payload = JSON.parse(approval.payloadJson) as { proposedDueDate?: string };
      if (body.decision === "approved") {
        if (!payload.proposedDueDate) return Response.json({ error: "审批单缺少建议交货日期。" }, { status: 409 });
        await db.update(orderItems).set({ dueDate: payload.proposedDueDate, updatedAt: now }).where(eq(orderItems.purchaseOrderId, approval.entityId));
        await db.update(purchaseOrders).set({ status: "confirmed", updatedAt: now }).where(eq(purchaseOrders.id, approval.entityId));
      } else {
        const confirmationDueAt = new Date(Date.now() + 86400000).toISOString();
        await db.update(purchaseOrders).set({ status: "factory_confirmation", updatedAt: now }).where(eq(purchaseOrders.id, approval.entityId));
        await createReminder({
          reminderType: "purchase_order_confirmation", entityType: "purchase_order", entityId: approval.entityId,
          businessNo: approval.requestNo, dueAt: confirmationDueAt, nextRunAt: confirmationDueAt,
          recurrence: "daily_overdue", recipientRoles: ["factory", "supply_chain"], severity: "approval",
        });
      }
    }
    if (approval.workflowType === "shipment_deviation") {
      await db.update(deliveryBatches).set({
        status: body.decision === "approved" ? "approved_to_ship" : "deviation_rejected",
        updatedAt: now,
      }).where(eq(deliveryBatches.id, approval.entityId));
    }
    if (approval.workflowType === "warehouse_transfer") {
      await db.update(inventoryTransfers).set({
        status: body.decision === "approved" ? "approved" : "rejected",
        approvedBy: access.userId,
        approvedAt: now,
        updatedAt: now,
      }).where(eq(inventoryTransfers.id, Number(approval.entityId)));
    }
    if (approval.workflowType === "warehouse_merge" && body.decision === "approved") {
      const payload = JSON.parse(approval.payloadJson || "{}") as { sourceId?: number; targetId?: number };
      const sourceId = Number(payload.sourceId);
      const targetId = Number(payload.targetId);
      const [source] = await db.select().from(warehouses).where(eq(warehouses.id, sourceId)).limit(1);
      const [target] = await db.select().from(warehouses).where(eq(warehouses.id, targetId)).limit(1);
      if (!source || !target || sourceId === targetId || source.status !== "active" || target.status !== "active") {
        return Response.json({ error: "源仓库或目标仓库状态已变化，无法执行合并。" }, { status: 409 });
      }
      await db.update(warehouses).set({ status: `merged:${targetId}`, updatedAt: now }).where(eq(warehouses.id, sourceId));
    }
    if (approval.workflowType === "stocktake_variance") {
      const [task] = await db.select().from(stocktakes)
        .where(eq(stocktakes.id, Number(approval.entityId))).limit(1);
      if (!task) return Response.json({ error: "待审核的盘点单不存在。" }, { status: 404 });
      const adjustments = await db.select().from(stocktakeAdjustments)
        .where(eq(stocktakeAdjustments.stocktakeId, task.id));
      for (const adjustment of adjustments) {
        const [count] = await db.select().from(stocktakeCounts)
          .where(eq(stocktakeCounts.id, adjustment.stocktakeCountId)).limit(1);
        if (!count) return Response.json({ error: "盘点差异明细不完整，无法审核。" }, { status: 409 });
        if (body.decision === "approved") {
          if (count.batchId) {
            await db.update(inventoryBatches).set({
              availableQuantity: count.availableQuantity,
              lockedQuantity: count.lockedQuantity,
              defectiveQuantity: count.defectiveQuantity,
              pendingInspectionQuantity: count.pendingInspectionQuantity,
              updatedAt: now,
            }).where(eq(inventoryBatches.id, count.batchId));
          } else {
            await db.insert(inventoryBatches).values({
              batchNo: adjustment.generatedBatchNo ?? `STG-${task.stocktakeNo}-${count.id}`,
              warehouseId: task.warehouseId,
              sku: count.sku,
              productionDate: adjustment.estimatedProductionDate,
              inboundDate: now.slice(0, 10),
              expiryDate: adjustment.estimatedExpiryDate,
              productionDateEstimated: true,
              expiryDateEstimated: true,
              availableQuantity: count.availableQuantity,
              lockedQuantity: count.lockedQuantity,
              defectiveQuantity: count.defectiveQuantity,
              pendingInspectionQuantity: count.pendingInspectionQuantity,
              ownership: "company",
              expiryStatus: "normal",
            });
          }
          await db.insert(inventoryMovements).values({
            warehouseId: task.warehouseId,
            sku: count.sku,
              type: "adjustment",
            quantity: adjustment.varianceQuantity,
            occurredAt: now,
            createdBy: access.userId,
          });
        }
        await db.update(stocktakeAdjustments).set({
          decision: body.decision,
          reviewedBy: access.userId,
          reviewedAt: now,
          updatedAt: now,
        }).where(eq(stocktakeAdjustments.id, adjustment.id));
      }
      await db.update(stocktakes).set({
        status: body.decision === "approved" ? "completed" : "recount",
        updatedAt: now,
      }).where(eq(stocktakes.id, task.id));
      if (body.decision === "approved") {
        await db.update(reminderSchedules).set({ status: "completed", updatedAt: now })
          .where(and(eq(reminderSchedules.entityType, "stocktake"), eq(reminderSchedules.entityId, task.id)));
      }
      await writeAudit(access, {
        action: body.decision === "approved" ? "approve" : "reject",
        module: "stocktake",
        entityType: "stocktake",
        entityId: task.id,
        after: { decision: body.decision, adjustmentCount: adjustments.length },
        request,
      });
    }
    if (approval.workflowType === "production_variance") {
      const [report] = await db.select().from(productionReports)
        .where(eq(productionReports.id, Number(approval.entityId))).limit(1);
      if (!report) return Response.json({ error: "待审核的生产完工报告不存在。" }, { status: 404 });
      const [execution] = await db.select().from(executionOrders)
        .where(eq(executionOrders.id, report.executionOrderId)).limit(1);
      if (!execution) return Response.json({ error: "关联生产单不存在。" }, { status: 404 });
      const payload = JSON.parse(approval.payloadJson || "{}") as { overproduction?: boolean };
      const acceptedQuantity = body.decision === "approved"
        ? report.actualFinishedQuantity
        : Math.min(report.actualFinishedQuantity, execution.plannedQuantity);
      const factoryOwnedQuantity = body.decision === "rejected" && payload.overproduction
        ? Math.max(0, report.actualFinishedQuantity - execution.plannedQuantity)
        : 0;
      if (body.decision === "approved" || payload.overproduction) {
        await assertProductionWarehouse(execution.factoryId);
      }
      await db.update(productionReports).set({
        result: body.decision === "approved" ? "approved" : (payload.overproduction ? "rejected_factory_owned" : report.result),
        companyInventoryQuantity: acceptedQuantity,
        factoryOwnedQuantity,
        reviewedBy: access.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(productionReports.id, report.id));
      await db.update(productionMaterialLines).set({
        deviationStatus: body.decision === "approved" ? "approved" : "rejected",
        updatedAt: now,
      }).where(eq(productionMaterialLines.executionOrderId, execution.id));
      await db.update(executionOrders).set({
        completedQuantity: acceptedQuantity,
        status: body.decision === "approved" ? "completed" : (payload.overproduction ? "completed_factory_owned" : "variance_rejected"),
        updatedAt: now,
      }).where(eq(executionOrders.id, execution.id));
      if (body.decision === "approved" || payload.overproduction) {
        await finalizeProductionInventory({
          executionOrderId: execution.id,
          reportId: report.id,
          companyQuantity: acceptedQuantity,
          factoryOwnedQuantity,
          actorId: access.userId,
        });
      }
    }
    if (approval.workflowType === "user_role_change") {
      const [roleRequest] = await db.select().from(userRoles).where(eq(userRoles.id, Number(approval.entityId))).limit(1);
      if (!roleRequest) return Response.json({ error: "待审核的角色申请不存在。" }, { status: 404 });
      const rolePayload = JSON.parse(approval.payloadJson) as { operation?: "assign" | "revoke" };
      const operation = rolePayload.operation ?? "assign";
      const expectedStatus = operation === "revoke" ? "active" : "pending";
      if (roleRequest.status !== expectedStatus) return Response.json({ error: "该角色申请已经处理或角色状态已改变。" }, { status: 409 });
      await db.update(userRoles).set({
        status: operation === "revoke"
          ? (body.decision === "approved" ? "revoked" : "active")
          : (body.decision === "approved" ? "active" : "revoked"),
        reviewedBy: access.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(userRoles.id, roleRequest.id));
    }
    if (approval.workflowType === "financial_record_correction" && body.decision === "approved") {
      const [original] = await db.select().from(paymentRecords).where(eq(paymentRecords.id, approval.entityId)).limit(1);
      if (!original) return Response.json({ error: "待更正的原财务记录不存在。" }, { status: 404 });
      const payload = JSON.parse(approval.payloadJson) as {
        proposedPaymentRequestId: number;
        proposedAmountMinor: number;
        proposedPaidAt: string;
        proposedBankReference: string;
        originalRecordType: "payment" | "refund" | "reversal" | "correction";
        invoiceExceptionId?: number | null;
      };
      await withDbTransaction(db, async tx => {
        await claimApproval(tx);
        await tx.insert(paymentRecords).values({
          paymentRequestId: original.paymentRequestId,
          amountMinor: -original.amountMinor,
          paidAt: now,
          bankReference: `冲正:${original.bankReference}`,
          recordType: "reversal",
          reversesPaymentRecordId: original.id,
          invoiceExceptionId: original.invoiceExceptionId,
          recordedBy: approval.requestedBy,
          reviewedBy: access.userId,
          reviewStatus: "approved",
        });
        await tx.insert(paymentRecords).values({
          paymentRequestId: payload.proposedPaymentRequestId,
          amountMinor: payload.proposedAmountMinor,
          paidAt: payload.proposedPaidAt,
          bankReference: payload.proposedBankReference,
          recordType: "correction",
          reversesPaymentRecordId: original.id,
          invoiceExceptionId: payload.invoiceExceptionId,
          recordedBy: approval.requestedBy,
          reviewedBy: access.userId,
          reviewStatus: "approved",
        });
        if (original.recordType === "refund" && original.invoiceExceptionId) {
          const [exception] = await tx.select().from(invoiceExceptions).where(eq(invoiceExceptions.id, original.invoiceExceptionId)).limit(1);
          if (exception) {
            const correctedRefund = Math.max(0, exception.refundedAmountMinor - original.amountMinor + payload.proposedAmountMinor);
            const resolved = correctedRefund + exception.replacementCoveredAmountMinor >= exception.affectedAmountMinor;
            await tx.update(invoiceExceptions).set({
              refundedAmountMinor: correctedRefund,
              status: resolved ? "resolved" : "awaiting_remediation",
              resolvedAt: resolved ? now : null,
              updatedAt: now,
            }).where(eq(invoiceExceptions.id, exception.id));
          }
        }
        for (const requestId of new Set([original.paymentRequestId, payload.proposedPaymentRequestId])) {
          const [paymentRequest] = await tx.select().from(factoryPaymentRequests).where(eq(factoryPaymentRequests.id, requestId)).limit(1);
          if (!paymentRequest) continue;
          const ledger = await tx.select().from(paymentRecords).where(eq(paymentRecords.paymentRequestId, requestId));
          const netPaid = ledger
            .filter((row) => ["payment", "correction", "reversal"].includes(row.recordType))
            .reduce((sum, row) => sum + row.amountMinor, 0);
          await tx.update(factoryPaymentRequests).set({
            status: netPaid >= paymentRequest.totalAmountMinor ? "paid" : netPaid > 0 ? "partially_paid" : "generated",
            paidAt: netPaid >= paymentRequest.totalAmountMinor ? payload.proposedPaidAt : null,
            updatedAt: now,
          }).where(eq(factoryPaymentRequests.id, requestId));
        }
      });
    }
    await writeAudit(access, { action: body.decision!, module: "approvals", entityType: approval.entityType, entityId: approval.entityId, businessNo: approval.requestNo, before: approval, after: { decision: body.decision, comment: body.comment }, request });
    return Response.json({ success: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
