import type { DataRow } from "../../platform/supply-support.js";

export interface OrderRow extends DataRow {
  id: number;
  orderNo: string;
  status: string;
  updatedAt: string;
}
