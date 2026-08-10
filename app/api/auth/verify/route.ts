import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { executeAffected } from "../../../../db/insert-one";
import { authChallenges, trustedDevices, users } from "../../../../db/schema";
import { executeUpsert } from "../../../../db/upsert";
import { hashSecret } from "../../../lib/crypto";
import { createSession } from "../../../lib/sessions";

export async function POST(request: Request) {
  const body = await request.json() as { challengeNo?: string; code?: string; deviceName?: string };
  if (!body.challengeNo || !body.code) return Response.json({ error: "验证码不能为空。" }, { status: 400 });
  const db = getDb();
  const nowIso = new Date().toISOString();
  const [challenge] = await db.select().from(authChallenges).where(and(
    eq(authChallenges.challengeNo, body.challengeNo),
    eq(authChallenges.purpose, "login"),
    isNull(authChallenges.verifiedAt),
    gt(authChallenges.expiresAt, nowIso),
  )).limit(1);
  if (!challenge) return Response.json({ error: "验证码已失效，请重新获取。" }, { status: 410 });
  if (challenge.attempts >= 5) return Response.json({ error: "验证码错误次数过多，请重新登录。" }, { status: 423 });
  const valid = await hashSecret(`${challenge.challengeNo}:${body.code}`) === challenge.codeHash;
  if (!valid) {
    const attemptedAt = new Date().toISOString();
    const incremented = await executeAffected(db.update(authChallenges).set({
      attempts: sql`${authChallenges.attempts} + 1`,
      updatedAt: attemptedAt,
    }).where(and(
      eq(authChallenges.id, challenge.id),
      eq(authChallenges.purpose, "login"),
      isNull(authChallenges.verifiedAt),
      gt(authChallenges.expiresAt, attemptedAt),
      lt(authChallenges.attempts, 5),
    )));
    if (incremented !== 1) {
      return Response.json({ error: "验证码错误次数过多，请重新登录。" }, { status: 423 });
    }
    return Response.json({ error: "验证码错误。" }, { status: 401 });
  }
  const now = new Date();
  const verifiedAt = now.toISOString();
  const claimed = await executeAffected(db.update(authChallenges).set({
    verifiedAt,
    updatedAt: verifiedAt,
  }).where(and(
    eq(authChallenges.id, challenge.id),
    eq(authChallenges.purpose, "login"),
    isNull(authChallenges.verifiedAt),
    gt(authChallenges.expiresAt, verifiedAt),
    lt(authChallenges.attempts, 5),
  )));
  if (claimed !== 1) {
    return Response.json({ error: "验证码已失效，请重新获取。" }, { status: 410 });
  }
  const [activeUser] = await db.select({ id: users.id }).from(users).where(and(
    eq(users.id, challenge.userId),
    eq(users.accountStatus, "active"),
  )).limit(1);
  if (!activeUser) {
    return Response.json({ error: "账号当前不可用，请联系管理员。" }, { status: 403 });
  }
  const trustedUntil = new Date(now.getTime() + 90 * 86400000).toISOString();
  const trustedDevice = {
    userId: challenge.userId, deviceId: challenge.deviceId, deviceName: body.deviceName ?? "",
    lastIpAddress: challenge.ipAddress, lastRegion: challenge.region,
    trustedUntil, lastUsedAt: verifiedAt,
  };
  await executeUpsert(db.insert(trustedDevices).values(trustedDevice), {
    conflictTarget: [trustedDevices.userId, trustedDevices.deviceId],
    set: { deviceName: body.deviceName ?? "", lastIpAddress: challenge.ipAddress, lastRegion: challenge.region, trustedUntil, revokedAt: null, lastUsedAt: verifiedAt, updatedAt: verifiedAt },
  });
  const session = await createSession({ userId: challenge.userId, deviceId: challenge.deviceId, ipAddress: challenge.ipAddress, region: challenge.region });
  return new Response(JSON.stringify({ authenticated: true, trustedUntil, expiresAt: session.expiresAt }), { headers: { "content-type": "application/json", "set-cookie": session.cookie } });
}
