import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { authChallenges } from "../../../../../db/schema";
import { accessErrorResponse, requireAccess } from "../../../../lib/authz";
import { hashSecret } from "../../../../lib/crypto";

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json() as { challengeNo?: string; code?: string };
    if (!body.challengeNo || !/^\d{6}$/.test(body.code ?? "")) return Response.json({ error: "请输入6位手机验证码。" }, { status: 400 });
    if (access.localPreview) return Response.json({ verified: true, challengeNo: body.challengeNo });
    const db = getDb();
    const [challenge] = await db.select().from(authChallenges).where(and(
      eq(authChallenges.challengeNo, body.challengeNo),
      eq(authChallenges.userId, access.userId),
      eq(authChallenges.purpose, "high_risk"),
    )).limit(1);
    if (!challenge || challenge.verifiedAt) return Response.json({ error: "验证码任务无效或已使用。" }, { status: 409 });
    if (new Date(challenge.expiresAt).getTime() < Date.now()) return Response.json({ error: "验证码已过期。" }, { status: 410 });
    if ((challenge.attempts ?? 0) >= 5) return Response.json({ error: "验证码错误次数过多，请重新发送。" }, { status: 423 });
    if (await hashSecret(body.code!) !== challenge.codeHash) {
      await db.update(authChallenges).set({ attempts: (challenge.attempts ?? 0) + 1, updatedAt: new Date().toISOString() }).where(eq(authChallenges.id, challenge.id));
      return Response.json({ error: "验证码错误。" }, { status: 401 });
    }
    const verifiedAt = new Date().toISOString();
    await db.update(authChallenges).set({ verifiedAt, updatedAt: verifiedAt }).where(eq(authChallenges.id, challenge.id));
    return Response.json({ verified: true, challengeNo: challenge.challengeNo });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
