import { and, eq } from "drizzle-orm";
import { getDb } from "@database/index";
import { factories, suppliers } from "@database/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/suppliers");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/suppliers");
}
