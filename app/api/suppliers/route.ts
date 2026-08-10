import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { approvalRequests, factories, suppliers } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, isInternal, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) {
      return Response.json({ suppliers: [], preview: true });
    }

    const db = getDb();
    if (isInternal(access)) {
      return Response.json({ suppliers: await db.select().from(suppliers).limit(200), factories: await db.select().from(factories).limit(200) });
    }
    if (access.factoryId) {
      return Response.json({
        suppliers: await db.select().from(suppliers)
          .where(eq(suppliers.managedByFactoryId, access.factoryId))
          .limit(200),
        factories: await db.select().from(factories).where(eq(factories.id, access.factoryId)).limit(1),
      });
    }
    if (access.supplierId) {
      return Response.json({
        suppliers: await db.select().from(suppliers)
          .where(and(eq(suppliers.id, access.supplierId), eq(suppliers.status, "active")))
          .limit(1),
        factories: [],
      });
    }
    return Response.json({ suppliers: [] });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json() as {
      code?: string; name?: string; tier?: 1 | 2 | 3; managedByFactoryId?: number;
      unifiedSocialCreditCode?: string; businessLicenseFileKey?: string;
      address?: string; contactName?: string; contactPhone?: string; businessScope?: string;
    };
    if (!body.code?.trim() || !body.name?.trim() || !body.tier) return Response.json({ error: "供应商代码、名称和层级不能为空。" }, { status: 400 });
    if (body.tier > 1 && !body.managedByFactoryId) return Response.json({ error: "第二、三层供应商必须指定所属组装工厂。" }, { status: 400 });
    if (!body.unifiedSocialCreditCode || !body.businessLicenseFileKey || !body.address || !body.contactName || !body.contactPhone || !body.businessScope) {
      return Response.json({ error: "营业执照、信用代码、地址、联系人、电话和经营范围必须完整。" }, { status: 400 });
    }
    const factoryCreatingTier3 = body.tier === 3 && access.roles.includes("factory") && access.factoryId === body.managedByFactoryId;
    if (!factoryCreatingTier3) requireRole(access, ["admin", "supply_chain"]);
    if (access.localPreview) return Response.json({ supplier: { ...body, id: 0 }, preview: true }, { status: 201 });
    const db = getDb();
    const supplier = await insertOne<typeof suppliers.$inferSelect>(db.insert(suppliers).values({
      code: body.code.trim(), name: body.name.trim(), tier: body.tier,
      managedByFactoryId: body.tier === 1 ? null : body.managedByFactoryId,
      unifiedSocialCreditCode: body.unifiedSocialCreditCode.trim(),
      businessLicenseFileKey: body.businessLicenseFileKey,
      address: body.address.trim(), contactName: body.contactName.trim(), contactPhone: body.contactPhone.trim(),
      businessScope: body.businessScope.trim(), source: "manual",
      verificationStatus: factoryCreatingTier3 ? "approved" : "pending",
      status: factoryCreatingTier3 ? "active" : "draft",
    }), id => db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1));
    if (!factoryCreatingTier3) {
      await db.insert(approvalRequests).values({
        requestNo: `AP-SUP-${Date.now()}`, workflowType: "supplier_onboarding", entityType: "supplier",
        entityId: supplier.id, summary: `新增${body.tier}层供应商：${supplier.name}`,
        payloadJson: JSON.stringify(body), requestedBy: access.userId,
      });
    }
    await writeAudit(access, { action: "create", module: "suppliers", entityType: "supplier", entityId: supplier.id, businessNo: supplier.code, after: supplier, request });
    return Response.json({ supplier, approvalRequired: !factoryCreatingTier3 }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
