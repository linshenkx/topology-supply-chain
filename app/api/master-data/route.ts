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

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ skus: [], conversions: [], boms: [], components: [], preview: true });
    const db = getDb();
    const internal = isInternal(access);
    const skuRows = internal
      ? await db.select().from(skus).orderBy(desc(skus.updatedAt)).limit(500)
      : await db.select().from(skus).where(eq(skus.status, "active")).limit(500);
    const bomRows = internal
      ? await db.select().from(productBoms).orderBy(desc(productBoms.updatedAt)).limit(500)
      : await db.select().from(productBoms).where(eq(productBoms.approvalStatus, "approved")).limit(500);
    const today = new Date().toISOString().slice(0, 10);
    return Response.json({
      skus: skuRows,
      conversions: await db.select().from(skuUnitConversions).limit(1000),
      boms: bomRows.map(row => ({ ...row, lifecycleStatus: lifecycle(row, today) })),
      components: await db.select().from(bomComponents).limit(2000),
    });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/master-data");
}
