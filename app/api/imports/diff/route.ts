import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { importBatches, importStagingRows } from "../../../../db/schema";
import { accessErrorResponse, requireAccess, requireRole } from "../../../lib/authz";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin", "supply_chain"]);
    const batchId = Number(new URL(request.url).searchParams.get("batchId"));
    if (!batchId) return Response.json({ error: "导入批次不能为空。" }, { status: 400 });
    if (access.localPreview) return Response.json({ added: [], changed: [], removed: [], preview: true });
    const db = getDb();
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
    if (!batch?.duplicateOfBatchId) return Response.json({ added: [], changed: [], removed: [] });
    const current = await db.select().from(importStagingRows).where(eq(importStagingRows.importBatchId, batch.id));
    const previous = await db.select().from(importStagingRows).where(eq(importStagingRows.importBatchId, batch.duplicateOfBatchId));
    const currentMap = new Map(current.map(row => [row.businessKey ?? String(row.sourceRowNo), JSON.parse(row.normalizedJson) as Record<string, unknown>]));
    const previousMap = new Map(previous.map(row => [row.businessKey ?? String(row.sourceRowNo), JSON.parse(row.normalizedJson) as Record<string, unknown>]));
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const changed: unknown[] = [];
    for (const [key, value] of currentMap) {
      const old = previousMap.get(key);
      if (!old) { added.push({ key, value }); continue; }
      const fields = Array.from(new Set([...Object.keys(old), ...Object.keys(value)])).filter(field => JSON.stringify(old[field]) !== JSON.stringify(value[field]));
      if (fields.length) changed.push({ key, fields: fields.map(field => ({ field, oldValue: old[field] ?? null, newValue: value[field] ?? null })) });
    }
    for (const [key, value] of previousMap) if (!currentMap.has(key)) removed.push({ key, value });
    return Response.json({ added, changed, removed });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
