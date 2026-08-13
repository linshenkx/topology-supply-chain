import { desc } from "drizzle-orm";
import { getDb } from "@database/index";
import { factories, factoryPlanResponses, purchasePlanItems, purchasePlans, warehouses } from "@database/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/purchase-plans");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/purchase-plans");
}

export async function PATCH() {
  return retiredPlatformRoute("/api/v1/purchase-plans");
}
