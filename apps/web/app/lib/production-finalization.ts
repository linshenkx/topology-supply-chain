import { and, eq } from "drizzle-orm";
import { getDb } from "@database/index";
import {
  executionOrders,
  inventoryBatches,
  inventoryMovements,
  orderItems,
  productionMaterialLines,
  warehouses,
} from "@database/schema";

const now = () => new Date().toISOString();

export async function assertProductionWarehouse(factoryId: number) {
  const db = getDb();
  const factoryWarehouses = await db.select().from(warehouses).where(and(
    eq(warehouses.factoryId, factoryId),
    eq(warehouses.status, "active"),
  ));
  const warehouse = factoryWarehouses.find(row => row.type === "factory") ?? factoryWarehouses[0];
  if (!warehouse) throw new Error("组装工厂尚未配置有效工厂仓，无法完成生产入库。");
  return warehouse;
}

/**
 * 将已结案的生产报告落到批次库存。公司库存先进入待检区，只有成品质检
 * 放行后才能变为可用库存；被拒绝的超产量独立记录为工厂自有库存。
 * 批次号固定，因此审批接口重试时不会重复入账。
 */
export async function finalizeProductionInventory(input: {
  executionOrderId: number;
  reportId: number;
  companyQuantity: number;
  factoryOwnedQuantity?: number;
  actorId: number;
}) {
  const db = getDb();
  const [execution] = await db.select().from(executionOrders)
    .where(eq(executionOrders.id, input.executionOrderId)).limit(1);
  if (!execution) throw new Error("关联生产单不存在，无法完成库存入账。");
  const [item] = await db.select().from(orderItems)
    .where(eq(orderItems.id, execution.orderItemId)).limit(1);
  if (!item) throw new Error("生产单关联的采购明细不存在。");

  const warehouse = await assertProductionWarehouse(execution.factoryId);
  if (!warehouse) throw new Error("组装工厂尚未配置有效工厂仓，无法完成生产入库。");

  const productionDate = (execution.actualFinishAt ?? now()).slice(0, 10);
  const inboundDate = now().slice(0, 10);
  const companyQuantity = Math.max(0, Math.trunc(input.companyQuantity));
  const factoryQuantity = Math.max(0, Math.trunc(input.factoryOwnedQuantity ?? 0));

  if (companyQuantity > 0) {
    const batchNo = `PROD-${execution.executionNo}-${input.reportId}-C`;
    const existing = await db.select({ id: inventoryBatches.id }).from(inventoryBatches)
      .where(and(eq(inventoryBatches.warehouseId, warehouse.id), eq(inventoryBatches.batchNo, batchNo))).limit(1);
    if (!existing.length) {
      await db.insert(inventoryBatches).values({
        batchNo,
        warehouseId: warehouse.id,
        sku: item.sku,
        productionDate,
        inboundDate,
        pendingInspectionQuantity: companyQuantity,
        ownership: "company",
      });
      await db.insert(inventoryMovements).values({
        warehouseId: warehouse.id,
        sku: item.sku,
        type: "inbound",
        quantity: companyQuantity,
        occurredAt: now(),
        createdBy: input.actorId,
      });
    }
  }

  if (factoryQuantity > 0) {
    const batchNo = `PROD-${execution.executionNo}-${input.reportId}-F`;
    const existing = await db.select({ id: inventoryBatches.id }).from(inventoryBatches)
      .where(and(eq(inventoryBatches.warehouseId, warehouse.id), eq(inventoryBatches.batchNo, batchNo))).limit(1);
    if (!existing.length) {
      await db.insert(inventoryBatches).values({
        batchNo,
        warehouseId: warehouse.id,
        sku: item.sku,
        productionDate,
        inboundDate,
        availableQuantity: factoryQuantity,
        ownership: "factory",
      });
    }
  }

  // 生产单结案后不再占用该生产任务的物料预留。
  await db.update(productionMaterialLines).set({ reservedQuantity: 0, updatedAt: now() })
    .where(eq(productionMaterialLines.executionOrderId, execution.id));

  return { warehouseId: warehouse.id, companyQuantity, factoryQuantity };
}
