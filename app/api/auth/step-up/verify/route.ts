import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { executeAffected } from "../../../../../db/insert-one";
import { authChallenges } from "../../../../../db/schema";
import { accessErrorResponse, requireAccess } from "../../../../lib/authz";
import { hashSecret } from "../../../../lib/crypto";
import { isPreviewStepUpVerification } from "../../../../lib/step-up-policy";

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json() as { challengeNo?: string; code?: string };
    if (!body.challengeNo || !/^\d{6}$/.test(body.code ?? "")) return Response.json({ error: "请输入6位手机验证码。" }, { status: 400 });
    if (access.localPreview) {
      if (!isPreviewStepUpVerification(body.challengeNo, body.code)) {
        return Response.json({ error: "验证码错误。" }, { status: 401 });
      }
      return Response.json({ verified: true, challengeNo: body.challengeNo });
    }
    const db = getDb();
    const now = new Date();
    const [challenge] = await db.select().from(authChallenges).where(and(
      eq(authChallenges.challengeNo, body.challengeNo),
      eq(authChallenges.userId, access.userId),
      eq(authChallenges.purpose, "high_risk"),
      isNull(authChallenges.verifiedAt),
      gt(authChallenges.expiresAt, now.toISOString()),
    )).limit(1);
    if (!challenge) return Response.json({ error: "验证码任务无效、已过期或已使用。" }, { status: 409 });
    if ((challenge.attempts ?? 0) >= 5) return Response.json({ error: "验证码错误次数过多，请重新发送。" }, { status: 423 });
    if (await hashSecret(`${challenge.challengeNo}:${body.code!}`) !== challenge.codeHash) {
      const attemptedAt = new Date().toISOString();
      const incremented = await executeAffected(db.update(authChallenges).set({
        attempts: sql`${authChallenges.attempts} + 1`,
        updatedAt: attemptedAt,
      }).where(and(
        eq(authChallenges.id, challenge.id),
        eq(authChallenges.userId, access.userId),
        eq(authChallenges.purpose, "high_risk"),
        isNull(authChallenges.verifiedAt),
        gt(authChallenges.expiresAt, attemptedAt),
        lt(authChallenges.attempts, 5),
      )));
      if (incremented !== 1) {
        return Response.json({ error: "验证码错误次数过多，请重新发送。" }, { status: 423 });
      }
      return Response.json({ error: "验证码错误。" }, { status: 401 });
    }
    const verifiedAt = new Date().toISOString();
    const claimed = await executeAffected(db.update(authChallenges).set({
      verifiedAt,
      updatedAt: verifiedAt,
    }).where(and(
      eq(authChallenges.id, challenge.id),
      eq(authChallenges.userId, access.userId),
      eq(authChallenges.purpose, "high_risk"),
      isNull(authChallenges.verifiedAt),
      gt(authChallenges.expiresAt, verifiedAt),
      lt(authChallenges.attempts, 5),
    )));
    if (claimed !== 1) {
      return Response.json({ error: "验证码任务无效、已过期或已使用。" }, { status: 409 });
    }
    return Response.json({ verified: true, challengeNo: challenge.challengeNo });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
