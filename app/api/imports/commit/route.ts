import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { approvalRequests, importBatches, importStagingRows, suppliers } from "../../../../db/schema";
import { insertOne } from "../../../../db/insert-one";
import { accessErrorResponse, requireAccess, requireRole } from "../../../lib/authz";
import { writeAudit } from "../../../lib/audit";

type SupplierMapping = { stagingRowId: number; tier: 1 | 2 | 3; managedByFactoryId?: number; legalName: string; businessScope: string; businessLicenseFileKey: string; contactName: string; contactPhone: string; address: string; unifiedSocialCreditCode: string };

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as { batchId?: number; confirmDuplicate?: boolean; supplierMappings?: SupplierMapping[] };
    if (!body.batchId) return Response.json({ error: "导入批次不能为空。" }, { status: 400 });
    if (access.localPreview) return Response.json({ success: true, preview: true });
    const db = getDb();
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, body.batchId)).limit(1);
    if (!batch) return Response.json({ error: "导入批次不存在。" }, { status: 404 });
    if (batch.errorCount > 0) return Response.json({ error: "该批次仍有错误行，禁止提交。" }, { status: 409 });
    if (batch.duplicateOfBatchId && !body.confirmDuplicate) return Response.json({ error: "疑似重复导入，必须先查看差异并确认更新。" }, { status: 409 });
    const rows = await db.select().from(importStagingRows).where(eq(importStagingRows.importBatchId, batch.id));
    if (batch.type !== "supplier") {
      await db.update(importBatches).set({ status: "awaiting_mapping", updatedAt: new Date().toISOString() }).where(eq(importBatches.id, batch.id));
      return Response.json({ success: false, awaitingMapping: true, message: "请先完成SKU、工厂、仓库、BOM及单位映射。" }, { status: 202 });
    }
    const mappings = new Map((body.supplierMappings ?? []).map(item => [item.stagingRowId, item]));
    for (const row of rows) {
      const mapping = mappings.get(row.id);
      if (!mapping || !mapping.tier || (mapping.tier > 1 && !mapping.managedByFactoryId) || !mapping.legalName || !mapping.businessScope || !mapping.businessLicenseFileKey || !mapping.contactName || !mapping.contactPhone || !mapping.address || !mapping.unifiedSocialCreditCode) {
        return Response.json({ error: `第${row.sourceRowNo}行的分层、归属或准入资料不完整。` }, { status: 409 });
      }
    }
    for (const row of rows) {
      const data = JSON.parse(row.normalizedJson) as { code: string; name: string };
      const mapping = mappings.get(row.id)!;
      const supplier = await insertOne<typeof suppliers.$inferSelect>(db.insert(suppliers).values({
        code: data.code, name: data.name, legalName: mapping.legalName, tier: mapping.tier,
        managedByFactoryId: mapping.tier === 1 ? null : mapping.managedByFactoryId,
        unifiedSocialCreditCode: mapping.unifiedSocialCreditCode, businessLicenseFileKey: mapping.businessLicenseFileKey,
        address: mapping.address, contactName: mapping.contactName, contactPhone: mapping.contactPhone,
        businessScope: mapping.businessScope, source: "lingxing_excel", verificationStatus: "pending", status: "draft",
      }), id => db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1));
      await db.insert(approvalRequests).values({
        requestNo: `AP-SUP-${Date.now()}-${supplier.id}`, workflowType: "supplier_onboarding",
        entityType: "supplier", entityId: supplier.id, summary: `导入供应商：${supplier.name}`,
        payloadJson: JSON.stringify({ batchId: batch.id, stagingRowId: row.id, mapping }), requestedBy: access.userId,
      });
    }
    const now = new Date().toISOString();
    await db.update(importBatches).set({ status: "committed", committedBy: access.userId, committedAt: now, updatedAt: now }).where(eq(importBatches.id, batch.id));
    await writeAudit(access, { action: "commit_import", module: "imports", entityType: "import_batch", entityId: batch.id, businessNo: batch.importNo, after: { rows: rows.length, type: batch.type }, request });
    return Response.json({ success: true, importedRows: rows.length, approvalRequired: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
