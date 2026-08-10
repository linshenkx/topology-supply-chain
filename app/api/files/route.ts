import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { fileObjects } from "../../../db/schema";
import { insertOne } from "../../../db/insert-one";
import { accessErrorResponse, isInternal, requireAccess } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";
import { getPreviewFileBucket, isAliyunRuntime } from "../../lib/runtime-env";

const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const form = await request.formData();
    const file = form.get("file");
    const category = String(form.get("category") ?? "").trim();
    if (!(file instanceof File) || !category) return Response.json({ error: "文件和文件分类不能为空。" }, { status: 400 });
    if (!ALLOWED_TYPES.has(file.type)) return Response.json({ error: "不支持该文件类型。" }, { status: 415 });
    if (file.size > 20 * 1024 * 1024) return Response.json({ error: "单个文件不能超过20MB。" }, { status: 413 });
    const sensitive = ["invoice", "payment", "bank_account", "price_evidence", "audit_export"].includes(category);
    const factoryPriceEvidence = category === "price_evidence" && access.roles.includes("factory");
    if (sensitive && !isInternal(access) && !factoryPriceEvidence) return Response.json({ error: "当前账号不能上传该类敏感文件。" }, { status: 403 });
    const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
    const objectKey = `${category}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;
    if (access.localPreview) return Response.json({ file: { id: 0, objectKey, fileName: file.name }, preview: true }, { status: 201 });
    const fileBytes = await file.arrayBuffer();
    if (isAliyunRuntime()) {
      const { putPrivateObject } = await import("../../lib/oss-store");
      await putPrivateObject({
        objectKey,
        body: new Uint8Array(fileBytes),
        contentType: file.type,
        originalName: file.name,
        uploadedBy: access.userId,
      });
    } else {
      const bucket = await getPreviewFileBucket();
      await bucket.put(objectKey, fileBytes, { httpMetadata: { contentType: file.type }, customMetadata: { originalName: file.name, uploadedBy: String(access.userId) } });
    }
    const retainUntil = new Date();
    retainUntil.setFullYear(retainUntil.getFullYear() + 5);
    const db = getDb();
    const record = await insertOne<typeof fileObjects.$inferSelect>(db.insert(fileObjects).values({
      objectKey, fileName: file.name, contentType: file.type, sizeBytes: file.size, category,
      entityType: String(form.get("entityType") ?? "") || null, entityId: String(form.get("entityId") ?? "") || null,
      ownerUserId: access.userId, factoryId: access.factoryId, supplierId: access.supplierId,
      sensitive, retainUntil: retainUntil.toISOString(),
    }), id => db.select().from(fileObjects).where(eq(fileObjects.id, id)).limit(1));
    await writeAudit(access, { action: "upload", module: "files", entityType: "file", entityId: record.id, after: { fileName: file.name, category, size: file.size }, request });
    return Response.json({ file: record }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!id || access.localPreview) return Response.json({ error: "文件不存在。" }, { status: 404 });
    const [record] = await getDb().select().from(fileObjects).where(eq(fileObjects.id, id)).limit(1);
    if (!record) return Response.json({ error: "文件不存在。" }, { status: 404 });
    const allowed = isInternal(access) || record.ownerUserId === access.userId || (access.factoryId && record.factoryId === access.factoryId) || (access.supplierId && record.supplierId === access.supplierId);
    if (!allowed) return Response.json({ error: "无权查看该文件。" }, { status: 403 });
    await writeAudit(access, { action: "download", module: "files", entityType: "file", entityId: record.id, sensitiveView: record.sensitive, request });
    if (isAliyunRuntime()) {
      const { getPrivateObject } = await import("../../lib/oss-store");
      const object = await getPrivateObject(record.objectKey);
      return new Response(Uint8Array.from(object.body), { headers: { "content-type": record.contentType, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.fileName)}`, "cache-control": "private, no-store" } });
    }
    const bucket = await getPreviewFileBucket();
    const object = await bucket.get(record.objectKey);
    if (!object) return Response.json({ error: "文件内容不存在。" }, { status: 404 });
    return new Response(object.body, { headers: { "content-type": record.contentType, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.fileName)}`, "cache-control": "private, no-store" } });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
