import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { factories, skus, supplierSkus, suppliers } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ relations: [], preview: true });
    const db = getDb();
    let rows: (typeof supplierSkus.$inferSelect)[];
    if (isInternal(access)) rows = await db.select().from(supplierSkus).orderBy(desc(supplierSkus.id)).limit(500);
    else if (access.factoryId) rows = await db.select().from(supplierSkus).where(eq(supplierSkus.factoryId, access.factoryId)).orderBy(desc(supplierSkus.id)).limit(500);
    else if (access.supplierId) rows = await db.select().from(supplierSkus).where(eq(supplierSkus.supplierId, access.supplierId)).orderBy(desc(supplierSkus.id)).limit(500);
    else rows = [];
    return Response.json({ relations: rows, suppliers: await db.select().from(suppliers).limit(500), factories: await db.select().from(factories).limit(200), skus: await db.select().from(skus).where(eq(skus.status, "active")).limit(1000) });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/supplier-skus");
}
