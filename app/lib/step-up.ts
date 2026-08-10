import { and, eq, gte, isNotNull } from "drizzle-orm";
import { getDb } from "../../db";
import { executeAffected } from "../../db/insert-one";
import { authChallenges } from "../../db/schema";
import { AccessError } from "./authz";
import {
  normalizeStepUpScope,
  PREVIEW_STEP_UP_CHALLENGE,
  STEP_UP_TTL_MS,
} from "./step-up-policy";

type StepUpDb = ReturnType<typeof getDb>;

type ConsumeStepUpInput = {
  challengeNo: unknown;
  userId: number;
  localPreview: boolean;
  scope: string;
  now?: Date;
};

export async function consumeVerifiedStepUp(
  db: StepUpDb | null,
  input: ConsumeStepUpInput,
) {
  const challengeNo = typeof input.challengeNo === "string"
    ? input.challengeNo.trim()
    : "";
  const scope = normalizeStepUpScope(input.scope);
  if (!scope) throw new Error("高风险操作的验证范围配置无效。");

  if (input.localPreview) {
    if (challengeNo !== PREVIEW_STEP_UP_CHALLENGE) {
      throw new AccessError(428, "高风险操作需要先完成手机验证码。");
    }
    return (input.now ?? new Date()).toISOString();
  }

  if (!db || !challengeNo) {
    throw new AccessError(428, "高风险操作需要先完成手机验证码。");
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const verifiedAfter = new Date(now.getTime() - STEP_UP_TTL_MS).toISOString();
  const consumed = await executeAffected(db.delete(authChallenges).where(and(
    eq(authChallenges.challengeNo, challengeNo),
    eq(authChallenges.userId, input.userId),
    eq(authChallenges.purpose, "high_risk"),
    eq(authChallenges.deviceId, scope),
    isNotNull(authChallenges.verifiedAt),
    gte(authChallenges.verifiedAt, verifiedAfter),
    gte(authChallenges.expiresAt, nowIso),
  )));

  if (consumed !== 1) {
    throw new AccessError(428, "手机验证码无效、已过期或已使用，请重新验证。");
  }
  return nowIso;
}
