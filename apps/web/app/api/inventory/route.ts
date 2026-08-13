import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@database/index";
import {
  inventoryBatches,
  inventoryReservations,
  inventoryTransfers,
  warehouses,
} from "@database/schema";
import { executeAffected, insertOne } from "@database/insert-one";
import {
  accessErrorResponse,
  isInternal,
  requireAccess,
  requireRole,
} from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { findInventoryFreeze } from "../../lib/inventory-freeze";
import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/inventory");
}

export async function POST(request: Request) {
  if (request.method.length >= 0) return retiredPlatformRoute("/api/v1/inventory");
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain", "factory"]);
    const body = (await request.json()) as {
      batchId?: number;
      entityType?: "purchase_order" | "production_order" | "shipment_plan" | "historical";
      entityId?: number;
      requestedQuantity?: number;
      priority?: number;
    };
    const requestedQuantity = Math.trunc(Number(body.requestedQuantity));
    if (!body.batchId || !body.entityType || requestedQuantity <= 0) {
      return Response.json({ error: "批次、预留业务类型和预留数量不能为空。" }, { status: 400 });
    }
    if (body.entityType !== "historical" && !body.entityId) {
      return Response.json({ error: "非历史预留必须关联业务单据。" }, { status: 400 });
    }
    if (access.localPreview) {
      return Response.json(
        {
          reservation: {
            id: 0,
            batchId: body.batchId,
            requestedQuantity,
            reservedQuantity: requestedQuantity,
            shortageQuantity: 0,
          },
          preview: true,
        },
        { status: 201 },
      );
    }

    const db = getDb();
    const [batch] = await db
      .select()
      .from(inventoryBatches)
      .where(eq(inventoryBatches.id, body.batchId))
      .limit(1);
    if (!batch) return Response.json({ error: "库存批次不存在。" }, { status: 404 });
    if (!isInternal(access)) {
      const [warehouse] = await db
        .select()
        .from(warehouses)
        .where(eq(warehouses.id, batch.warehouseId))
        .limit(1);
      if (!warehouse || warehouse.factoryId !== access.factoryId) {
        return Response.json({ error: "无权操作该仓库库存。" }, { status: 403 });
      }
    }
    const freeze = await findInventoryFreeze({ warehouseId: batch.warehouseId, sku: batch.sku, batchId: batch.id });
    if (freeze) {
      return Response.json({ error: `盘点 ${freeze.stocktakeNo} 期间禁止预留或变更库存。` }, { status: 409 });
    }
    if (batch.expiryStatus === "expired_frozen" || batch.quarantineQuantity > 0) {
      return Response.json({ error: "过期冻结或隔离批次禁止预留。" }, { status: 409 });
    }

    // 条件更新是最终防线：并发请求也无法把可用库存扣成负数。
    const reservedQuantity = Math.min(requestedQuantity, Math.max(0, batch.availableQuantity));
    const shortageQuantity = Math.max(0, requestedQuantity - reservedQuantity);
    const updated = reservedQuantity === 0 ? 1 : await executeAffected(db
      .update(inventoryBatches)
      .set({
        availableQuantity: sql`${inventoryBatches.availableQuantity} - ${reservedQuantity}`,
        lockedQuantity: sql`${inventoryBatches.lockedQuantity} + ${reservedQuantity}`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(inventoryBatches.id, body.batchId),
          sql`${inventoryBatches.availableQuantity} >= ${reservedQuantity}`,
        ),
      ));
    if (!updated) {
      return Response.json(
        {
          error: "可用库存不足，系统禁止产生负库存。",
          availableQuantity: batch.availableQuantity,
          requestedQuantity,
          shortageQuantity: Math.max(0, requestedQuantity - batch.availableQuantity),
        },
        { status: 409 },
      );
    }

    const reservation = await insertOne<typeof inventoryReservations.$inferSelect>(
      db.insert(inventoryReservations).values({
        batchId: body.batchId,
        entityType: body.entityType,
        entityId: body.entityId,
        requestedQuantity,
        reservedQuantity,
        shortageQuantity,
        priority: body.priority ?? 0,
        createdBy: access.userId,
      }),
      id => db.select().from(inventoryReservations).where(eq(inventoryReservations.id, id)).limit(1),
    );
    await writeAudit(access, {
      action: "reserve",
      module: "inventory",
      entityType: "inventory_reservation",
      entityId: reservation.id,
      after: reservation,
      request,
    });
    return Response.json({ reservation }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
