import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@database/index";
import { stocktakeCounts, stocktakes } from "@database/schema";

const ACTIVE = ["frozen", "first_count", "recount", "pending_approval"] as const;

export async function findInventoryFreeze(input: { warehouseId: number; sku?: string; batchId?: number }) {
  const db = getDb();
  const tasks = await db.select().from(stocktakes).where(and(
    eq(stocktakes.warehouseId, input.warehouseId),
    inArray(stocktakes.status, ACTIVE),
  ));
  for (const task of tasks) {
    if (task.scope === "full_warehouse") return task;
    const targetFilter = input.batchId && input.sku
      ? or(eq(stocktakeCounts.batchId, input.batchId), eq(stocktakeCounts.sku, input.sku))
      : input.batchId
        ? eq(stocktakeCounts.batchId, input.batchId)
        : input.sku
          ? eq(stocktakeCounts.sku, input.sku)
          : undefined;
    if (!targetFilter) continue;
    const target = await db.select({ id: stocktakeCounts.id }).from(stocktakeCounts).where(and(
      eq(stocktakeCounts.stocktakeId, task.id),
      eq(stocktakeCounts.countRound, 0),
      targetFilter,
    )).limit(1);
    if (target.length) return task;
  }
  return null;
}
