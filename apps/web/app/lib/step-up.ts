import { createHash } from "node:crypto";
import { and, eq, gte, isNotNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { getDb } from "@database/index";
import { executeAffected } from "@database/insert-one";
import { authChallenges } from "@database/schema";
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
  sessionId?: number | null;
  action?: string;
  objectType?: string;
  objectId?: string;
  objectVersion?: number;
  requestDigest?: string;
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
  if (!input.sessionId || !input.action || !input.objectType || !input.objectId ||
      !Number.isSafeInteger(input.objectVersion) || (input.objectVersion ?? 0) <= 0 ||
      !/^[a-f\d]{64}$/iu.test(input.requestDigest ?? "")) {
    throw new AccessError(428, "高风险验证与当前请求不匹配，请重新验证。");
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const verifiedAfter = new Date(now.getTime() - STEP_UP_TTL_MS).toISOString();
  const bindingWhere = and(
    eq(authChallenges.challengeNo, challengeNo),
    eq(authChallenges.userId, input.userId),
    eq(authChallenges.sessionId, input.sessionId),
    eq(authChallenges.purpose, "high_risk"),
    eq(authChallenges.deviceId, scope),
    eq(authChallenges.action, input.action),
    eq(authChallenges.objectType, input.objectType),
    eq(authChallenges.objectId, input.objectId),
    isNotNull(authChallenges.verifiedAt),
    gte(authChallenges.verifiedAt, verifiedAfter),
    gte(authChallenges.expiresAt, nowIso),
  );
  const [binding] = await db.select({
    objectVersion: authChallenges.objectVersion,
    requestDigest: authChallenges.requestDigest,
  }).from(authChallenges).where(bindingWhere).limit(1);
  if (binding === undefined || binding.requestDigest !== input.requestDigest!.toLowerCase()) {
    throw new AccessError(428, "手机验证码无效、已过期或与请求不匹配，请重新验证。");
  }
  if (binding.objectVersion !== input.objectVersion) {
    throw new AccessError(409, "对象版本已经变化，请刷新后重新验证。");
  }
  const consumed = await executeAffected(db.delete(authChallenges).where(and(
    bindingWhere,
    eq(authChallenges.objectVersion, input.objectVersion!),
    eq(authChallenges.requestDigest, input.requestDigest!.toLowerCase()),
  )));

  if (consumed !== 1) {
    throw new AccessError(428, "手机验证码无效、已过期或已使用，请重新验证。");
  }
  return nowIso;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function finalRequestDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

export function databaseObjectVersion(column: AnyColumn): SQL<number> {
  return sql<number>`CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${column}) DIV 1000 AS UNSIGNED)`.mapWith(Number);
}

export function nextDatabaseUpdatedAt(column: AnyColumn): SQL<string> {
  return sql<string>`GREATEST(CURRENT_TIMESTAMP(3), DATE_ADD(${column}, INTERVAL 1 MILLISECOND))`;
}
