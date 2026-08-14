import type { DataRow } from "../../platform/supply-support.js";

export interface SupplierRow extends DataRow {
  id: number;
  managedByFactoryId: number | null;
  tier: number | null;
}

export interface PriceRow extends DataRow {
  id: number;
  taxRateBps: number;
  unitPriceTaxExcludedMinor: number;
  unitPriceTaxIncludedMinor: number;
}
