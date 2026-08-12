import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { bomComponents, productBoms, skuUnitConversions, skus } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

const lifecycle = (row: typeof productBoms.$inferSelect, today: string) => {
  if (!row.active) return "inactive";
  if (row.approvalStatus !== "approved") return row.approvalStatus;
  if (row.effectiveFrom > today) return "future";
  if (row.effectiveTo && row.effectiveTo < today) return "expired";
  return "effective";
};

export async function GET() {
  return retiredPlatformRoute("/api/v1/master-data");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/master-data");
}
