import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { factories, suppliers } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ suppliers: [], preview: true });
    const db = getDb();
    if (isInternal(access)) return Response.json({ suppliers: await db.select().from(suppliers).limit(200), factories: await db.select().from(factories).limit(200) });
    if (access.factoryId) return Response.json({ suppliers: await db.select().from(suppliers).where(eq(suppliers.managedByFactoryId, access.factoryId)).limit(200), factories: await db.select().from(factories).where(eq(factories.id, access.factoryId)).limit(1) });
    if (access.supplierId) return Response.json({ suppliers: await db.select().from(suppliers).where(and(eq(suppliers.id, access.supplierId), eq(suppliers.status, "active"))).limit(1), factories: [] });
    return Response.json({ suppliers: [] });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/suppliers");
}
