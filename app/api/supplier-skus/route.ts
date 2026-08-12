import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { factories, skus, supplierSkus, suppliers } from "../../../db/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/supplier-skus");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/supplier-skus");
}
