import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { importBatches, importStagingRows } from "../../../../db/schema";
import { insertOne } from "../../../../db/insert-one";
import { accessErrorResponse, requireAccess, requireRole } from "../../../lib/authz";
import { writeAudit } from "../../../lib/audit";

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const body = await request.json() as {
      type?: string; fileName?: string; fingerprint?: string; businessKey?: string;
      rows?: Array<Record<string, unknown>>; errors?: unknown[]; warnings?: unknown[];
    };
    if (!body.type || !body.fileName || !body.fingerprint || !Array.isArray(body.rows)) {
      return Response.json({ error: "导入类型、文件、指纹和预检数据不能为空。" }, { status: 400 });
    }
    if (body.errors?.length) return Response.json({ error: "存在错误行，禁止进入正式导入流程。", errors: body.errors }, { status: 409 });
    if (access.localPreview) return Response.json({ batch: { id: 0, importNo: `IMP-PREVIEW-${Date.now()}`, status: "awaiting_mapping" }, preview: true }, { status: 201 });
    const db = getDb();
    const [duplicate] = await db.select().from(importBatches).where(eq(importBatches.fingerprint, body.fingerprint)).orderBy(desc(importBatches.createdAt)).limit(1);
    const status = duplicate ? "awaiting_duplicate_confirmation" : "awaiting_mapping";
    const batch = await insertOne<typeof importBatches.$inferSelect>(db.insert(importBatches).values({
      importNo: `IMP-${Date.now()}`, type: body.type, fileName: body.fileName, fingerprint: body.fingerprint,
      businessKey: body.businessKey, status, totalRows: body.rows.length, validRows: body.rows.length,
      warningCount: body.warnings?.length ?? 0, duplicateOfBatchId: duplicate?.id, createdBy: access.userId,
    }), id => db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1));
    for (const row of body.rows) {
      await db.insert(importStagingRows).values({
        importBatchId: batch.id, sheetName: String(row.sheetName ?? "sheet1"),
        sourceRowNo: Number(row.sourceRow ?? 0), businessKey: String(row.businessKey ?? row.sku ?? row.code ?? ""),
        normalizedJson: JSON.stringify(row), rawJson: JSON.stringify(row),
        validationStatus: "valid", mappingConfirmed: false,
      });
    }
    await writeAudit(access, { action: "stage_import", module: "imports", entityType: "import_batch", entityId: batch.id, businessNo: batch.importNo, after: { type: body.type, fileName: body.fileName, totalRows: body.rows.length, duplicateOf: duplicate?.id }, request });
    return Response.json({ batch, duplicate: duplicate ? { id: duplicate.id, importNo: duplicate.importNo, status: duplicate.status, createdAt: duplicate.createdAt } : null }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
