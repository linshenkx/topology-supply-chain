import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { notificationMessages } from "../../../db/schema";
import { accessErrorResponse, requireAccess } from "../../lib/authz";

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    if (access.localPreview) return Response.json({ notifications: [], unread: 0, preview: true });
    const rows = await getDb().select().from(notificationMessages)
      .where(eq(notificationMessages.recipientUserId, access.userId))
      .orderBy(desc(notificationMessages.createdAt)).limit(100);
    return Response.json({ notifications: rows, unread: rows.filter(row => !row.readAt).length });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json() as { id?: number };
    if (!body.id) return Response.json({ error: "通知ID不能为空。" }, { status: 400 });
    if (access.localPreview) return Response.json({ success: true, preview: true });
    await getDb().update(notificationMessages).set({
      status: "read", readAt: new Date().toISOString(),
    }).where(and(eq(notificationMessages.id, body.id), eq(notificationMessages.recipientUserId, access.userId)));
    return Response.json({ success: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
