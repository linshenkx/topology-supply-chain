import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { authChallenges, trustedDevices } from "../../../../db/schema";
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
    await db.update(authChallenges).set({ attempts: challenge.attempts + 1, updatedAt: new Date().toISOString() }).where(eq(authChallenges.id, challenge.id));
    return Response.json({ error: "验证码错误。" }, { status: 401 });
  }
  const now = new Date();
  await db.update(authChallenges).set({ verifiedAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(authChallenges.id, challenge.id));
  await db.insert(trustedDevices).values({
    userId: challenge.userId, deviceId: challenge.deviceId, deviceName: body.deviceName ?? "",
    lastIpAddress: challenge.ipAddress, lastRegion: challenge.region,
    trustedUntil: new Date(now.getTime() + 90 * 86400000).toISOString(), lastUsedAt: now.toISOString(),
  }).onConflictDoUpdate({
    target: [trustedDevices.userId, trustedDevices.deviceId],
    set: { deviceName: body.deviceName ?? "", lastIpAddress: challenge.ipAddress, lastRegion: challenge.region, trustedUntil: new Date(now.getTime() + 90 * 86400000).toISOString(), revokedAt: null, lastUsedAt: now.toISOString(), updatedAt: now.toISOString() },
  });
  const session = await createSession({ userId: challenge.userId, deviceId: challenge.deviceId, ipAddress: challenge.ipAddress, region: challenge.region });
  return new Response(JSON.stringify({ authenticated: true, trustedUntil: new Date(now.getTime() + 90 * 86400000).toISOString(), expiresAt: session.expiresAt }), { headers: { "content-type": "application/json", "set-cookie": session.cookie } });
}
