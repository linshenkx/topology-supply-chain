import type { QueryExecutor } from "../../infrastructure/database.js";
import type { DataRow } from "../../platform/supply-support.js";

export interface PlanItemRow extends DataRow {
  bomId: number;
  completionStatus: string;
  factoryId: number;
  id: number;
  orderedQuantity: number;
  overToleranceBps: number;
  plannedQuantity: number;
  purchasePlanId: number;
  sku: string;
  underToleranceBps: number;
  warehouseId: number;
}

export interface PlanRow extends DataRow {
  confirmationDueAt: string | null;
  id: number;
  planNo: string;
  status: string;
  updatedAt: string;
  version: number;
}

export async function planItems(transaction: QueryExecutor, planId: number): Promise<readonly PlanItemRow[]> {
  return transaction.query<PlanItemRow>(
    `SELECT id, purchase_plan_id AS purchasePlanId, factory_id AS factoryId,
            warehouse_id AS warehouseId, sku, bom_id AS bomId,
            planned_quantity AS plannedQuantity, ordered_quantity AS orderedQuantity,
            over_tolerance_bps AS overToleranceBps, under_tolerance_bps AS underToleranceBps,
            completion_status AS completionStatus
     FROM purchase_plan_items WHERE purchase_plan_id = ? ORDER BY id FOR UPDATE`,
    [planId],
  );
}
