import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { executeAffected } from "../../../../db/insert-one";
import { authChallenges, authCredentials, trustedDevices, users } from "../../../../db/schema";
import { withDbTransaction } from "../../../../db/transaction";
import { isLocalPreviewRequest } from "../../../lib/access-boundary";
import { hashPassword, hashSecret, randomDigits } from "../../../lib/crypto";
import { runtimeEnv } from "../../../lib/runtime-env";
import { createSession } from "../../../lib/sessions";
import { isSmsConfigured, sendVerificationSms } from "../../../lib/sms";

export async function POST(request: Request) {
  const body = await request.json() as {
    account?: string;
    password?: string;
    deviceId?: string;
    deviceName?: string;
  };
  if (!body.account?.trim() || !body.password || !body.deviceId) {
    return Response.json({ error: "账号、密码和设备标识不能为空。" }, { status: 400 });
  }

  const db = getDb();
  const [user] = await db.select().from(users)
    .where(eq(users.email, body.account.trim().toLowerCase())).limit(1);
  if (!user) return Response.json({ error: "账号或密码错误。" }, { status: 401 });
  if (["locked", "disabled"].includes(user.accountStatus)) {
    return Response.json({
      error: user.accountStatus === "locked"
        ? "账号已锁定，请联系管理员解锁。"
        : "账号已停用。",
    }, { status: 423 });
  }

  const [credential] = await db.select().from(authCredentials)
    .where(eq(authCredentials.userId, user.id)).limit(1);
  if (!credential) return Response.json({ error: "账号尚未设置密码。" }, { status: 403 });

  const passwordHash = await hashPassword(body.password, credential.passwordSalt);
  if (passwordHash !== credential.passwordHash) {
    const attempts = await withDbTransaction(db, async tx => {
      const attemptedAt = new Date().toISOString();
      const incremented = await executeAffected(tx.update(authCredentials).set({
        failedAttempts: sql`${authCredentials.failedAttempts} + 1`,
        updatedAt: attemptedAt,
      }).where(and(
        eq(authCredentials.id, credential.id),
        lt(authCredentials.failedAttempts, 5),
      )));
      const [latestCredential] = await tx.select({
        failedAttempts: authCredentials.failedAttempts,
      }).from(authCredentials).where(eq(authCredentials.id, credential.id)).limit(1);
      if (!latestCredential) throw new Error("登录凭证已不存在。");
      const latestAttempts = Math.min(latestCredential.failedAttempts, 5);
      if (incremented !== 1 && latestAttempts < 5) {
        throw new Error("登录失败次数更新未生效。");
      }
      if (latestAttempts >= 5) {
        await tx.update(authCredentials).set({
          lockedAt: attemptedAt,
          updatedAt: attemptedAt,
        }).where(and(
          eq(authCredentials.id, credential.id),
          isNull(authCredentials.lockedAt),
        ));
        await tx.update(users).set({
          accountStatus: "locked",
          updatedAt: attemptedAt,
        }).where(and(
          eq(users.id, user.id),
          eq(users.accountStatus, user.accountStatus),
        ));
      }
      return latestAttempts;
    });
    return Response.json({
      error: attempts >= 5
        ? "连续失败5次，账号已锁定。"
        : `账号或密码错误，还可尝试${5 - attempts}次。`,
    }, { status: 401 });
  }

  const credentialReset = await withDbTransaction(db, async tx => {
    const resetAt = new Date().toISOString();
    const reset = await executeAffected(tx.update(authCredentials).set({
      failedAttempts: 0,
      lockedAt: null,
      updatedAt: resetAt,
    }).where(and(
      eq(authCredentials.id, credential.id),
      eq(authCredentials.failedAttempts, credential.failedAttempts),
      eq(authCredentials.updatedAt, credential.updatedAt),
      isNull(authCredentials.lockedAt),
      lt(authCredentials.failedAttempts, 5),
    )));
    if (reset !== 1) return false;
    const [activeUser] = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.id, user.id),
      eq(users.accountStatus, "active"),
    )).limit(1);
    return Boolean(activeUser);
  });
  if (!credentialReset) {
    return Response.json({ error: "账号状态已变化，请重新登录。" }, { status: 423 });
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("cf-connecting-ip");
  const region = request.headers.get("cf-ipcountry")
    ?? request.headers.get("x-topology-region");
  const nowIso = new Date().toISOString();
  const [device] = await db.select().from(trustedDevices).where(and(
    eq(trustedDevices.userId, user.id),
    eq(trustedDevices.deviceId, body.deviceId),
    isNull(trustedDevices.revokedAt),
    gt(trustedDevices.trustedUntil, nowIso),
  )).limit(1);
  const trusted = device &&
    (!device.lastRegion || !region || device.lastRegion === region);

  if (trusted) {
    const [activeUser] = await db.select({ id: users.id }).from(users).where(and(
      eq(users.id, user.id),
      eq(users.accountStatus, "active"),
    )).limit(1);
    if (!activeUser) {
      return Response.json({ error: "账号当前不可用，请联系管理员。" }, { status: 423 });
    }
    const session = await createSession({
      userId: user.id,
      deviceId: body.deviceId,
      ipAddress,
      region,
    });
    await db.update(trustedDevices).set({
      lastIpAddress: ipAddress,
      lastRegion: region,
      lastUsedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(trustedDevices.id, device.id));
    return new Response(JSON.stringify({
      authenticated: true,
      expiresAt: session.expiresAt,
    }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": session.cookie,
      },
    });
  }

  if (!user.mobile) {
    return Response.json({ error: "账号未绑定手机号，请联系管理员。" }, { status: 409 });
  }
  const local = isLocalPreviewRequest({
    requestUrl: request.url,
    appEnv: runtimeEnv("APP_ENV"),
    deployTarget: runtimeEnv("DEPLOY_TARGET"),
    nodeEnv: runtimeEnv("NODE_ENV"),
  });
  if (!local && !isSmsConfigured()) {
    return Response.json({ error: "短信服务尚未配置。" }, { status: 503 });
  }

  const code = randomDigits();
  const challengeNo = `OTP-${crypto.randomUUID()}`;
  const [activeUser] = await db.select({ id: users.id }).from(users).where(and(
    eq(users.id, user.id),
    eq(users.accountStatus, "active"),
  )).limit(1);
  if (!activeUser) {
    return Response.json({ error: "账号当前不可用，请联系管理员。" }, { status: 423 });
  }
  await db.insert(authChallenges).values({
    challengeNo,
    userId: user.id,
    purpose: "login",
    codeHash: await hashSecret(`${challengeNo}:${code}`),
    deviceId: body.deviceId,
    ipAddress,
    region,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });

  if (!local) {
    try {
      await sendVerificationSms({ mobile: user.mobile, code, purpose: "login" });
    } catch (error) {
      await db.delete(authChallenges).where(eq(authChallenges.challengeNo, challengeNo));
      console.error("SMS delivery failed.", error instanceof Error ? error.message : "Unknown error");
      return Response.json({ error: "验证码发送失败，请稍后重试。" }, { status: 502 });
    }
  }

  return Response.json({
    authenticated: false,
    challengeNo,
    maskedMobile: `${user.mobile.slice(0, 3)}****${user.mobile.slice(-4)}`,
    ...(local ? { previewCode: code } : {}),
  });
}
