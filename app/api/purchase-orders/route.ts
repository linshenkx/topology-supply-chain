import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { orderItems, purchaseOrders, purchasePlanItems, purchasePlanOrderLinks, reminderSchedules } from "../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/purchase-orders");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/purchase-orders");
}

export async function PATCH() {
  return retiredPlatformRoute("/api/v1/purchase-orders");
}
