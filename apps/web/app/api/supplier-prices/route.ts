import { desc, eq } from "drizzle-orm";
import { getDb } from "@database/index";
import { corePriceAgreements, corePriceChangeRequests, orderItems, purchaseOrders, skus, supplierSkus, suppliers } from "@database/schema";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/supplier-prices");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/supplier-prices");
}
