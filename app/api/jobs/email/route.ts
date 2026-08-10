import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { notificationMessages, users } from "../../../../db/schema";
import { runtimeEnv } from "../../../lib/runtime-env";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const localPreview = ["localhost", "127.0.0.1"].includes(url.hostname);
  const token = request.headers.get("x-topology-job-token");
  const jobToken = runtimeEnv("JOB_TOKEN");
  const emailWebhookUrl = runtimeEnv("EMAIL_WEBHOOK_URL");
  if (!localPreview && (!jobToken || token !== jobToken)) return Response.json({ error: "后台任务认证失败。" }, { status: 401 });
  if (!emailWebhookUrl) return Response.json({ queued: true, sent: 0, message: "邮件服务尚未绑定，消息保留在队列中。" }, { status: 202 });
  const db = getDb();
  const queued = await db.select({ message: notificationMessages, user: users }).from(notificationMessages)
    .innerJoin(users, eq(users.id, notificationMessages.recipientUserId))
    .where(and(eq(notificationMessages.channel, "email"), eq(notificationMessages.status, "queued"))).limit(100);
  let sent = 0;
  for (const row of queued) {
    try {
      const response = await fetch(emailWebhookUrl, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": runtimeEnv("EMAIL_WEBHOOK_API_KEY") ?? "" },
        body: JSON.stringify({ to: row.user.email, subject: row.message.title, text: row.message.message, businessNo: row.message.businessNo }),
      });
      if (!response.ok) throw new Error(`邮件服务返回${response.status}`);
      await db.update(notificationMessages).set({ status: "sent", sentAt: new Date().toISOString() }).where(eq(notificationMessages.id, row.message.id));
      sent++;
    } catch (error) {
      await db.update(notificationMessages).set({ status: "failed", errorMessage: error instanceof Error ? error.message : "发送失败" }).where(eq(notificationMessages.id, row.message.id));
    }
  }
  return Response.json({ processed: queued.length, sent });
}
