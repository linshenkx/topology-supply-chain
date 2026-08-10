import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { authChallenges, users } from "../../../../../db/schema";
import { accessErrorResponse, requireAccess } from "../../../../lib/authz";
import { hashSecret, randomDigits, randomToken } from "../../../../lib/crypto";
import { isSmsConfigured, sendVerificationSms } from "../../../../lib/sms";
import {
  normalizeStepUpScope,
  PREVIEW_STEP_UP_CHALLENGE,
  PREVIEW_STEP_UP_CODE,
} from "../../../../lib/step-up-policy";

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    const body = await request.json().catch(() => ({})) as { scope?: string; deviceId?: string };
    const scope = normalizeStepUpScope(body.scope ?? body.deviceId);
    if (!scope) return Response.json({ error: "高风险操作的验证范围无效。" }, { status: 400 });
    if (access.localPreview) return Response.json({ challengeNo: PREVIEW_STEP_UP_CHALLENGE, expiresInSeconds: 300, previewCode: PREVIEW_STEP_UP_CODE, scope });
    const db = getDb();
    const [user] = await db.select({ mobile: users.mobile }).from(users).where(eq(users.id, access.userId)).limit(1);
    if (!user?.mobile) return Response.json({ error: "当前账号没有绑定手机号。" }, { status: 409 });
    if (!isSmsConfigured()) return Response.json({ error: "短信服务尚未配置。" }, { status: 503 });
    const code = randomDigits(6);
    const challengeNo = `HR-${randomToken().slice(0, 16)}`;
    const now = new Date();
    await db.insert(authChallenges).values({
      challengeNo, userId: access.userId, purpose: "high_risk",
      codeHash: await hashSecret(`${challengeNo}:${code}`), deviceId: scope,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      attempts: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    try {
      await sendVerificationSms({ mobile: user.mobile, code, purpose: "high-risk" });
    } catch (error) {
      await db.delete(authChallenges).where(eq(authChallenges.challengeNo, challengeNo));
      throw error;
    }
    return Response.json({ challengeNo, expiresInSeconds: 300, mobile: `${user.mobile.slice(0, 3)}****${user.mobile.slice(-4)}`, scope });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
