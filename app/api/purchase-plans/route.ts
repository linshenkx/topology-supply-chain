import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { factories, factoryPlanResponses, purchasePlanItems, purchasePlans, warehouses } from "../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    if (access.localPreview) return Response.json({ plans: [], preview: true });
    const db = getDb();
    const [allPlans, allItems, allFactories, allWarehouses, allResponses] = await Promise.all([
      db.select().from(purchasePlans).orderBy(desc(purchasePlans.createdAt)).limit(200),
      db.select().from(purchasePlanItems), db.select().from(factories), db.select().from(warehouses),
      db.select().from(factoryPlanResponses).orderBy(desc(factoryPlanResponses.createdAt)),
    ]);
    const factoryNames = new Map(allFactories.map(row => [row.id, row.name]));
    const warehouseNames = new Map(allWarehouses.map(row => [row.id, row.name]));
    const latestResponse = new Map<string, typeof allResponses[number]>();
    for (const row of allResponses) {
      const key = `${row.purchasePlanId}:${row.factoryId}`;
      if (!latestResponse.has(key)) latestResponse.set(key, row);
    }
    const plans = allPlans.flatMap(plan => {
      const items = allItems.filter(item => item.purchasePlanId === plan.id && (!access.factoryId || item.factoryId === access.factoryId)).map(item => ({ ...item, factoryName: factoryNames.get(item.factoryId) ?? `工厂#${item.factoryId}`, warehouseName: warehouseNames.get(item.warehouseId) ?? `仓库#${item.warehouseId}` }));
      if (!items.length) return [];
      const factoryIds = Array.from(new Set(items.map(item => item.factoryId)));
      return [{ ...plan, items, responses: factoryIds.map(factoryId => latestResponse.get(`${plan.id}:${factoryId}`)).filter(Boolean) }];
    });
    return Response.json({ plans });
  } catch (error) { return accessErrorResponse(error); }
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/purchase-plans");
}

export async function PATCH() {
  return retiredPlatformRoute("/api/v1/purchase-plans");
}
