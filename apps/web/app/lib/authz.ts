import { and, eq, or, isNotNull, isNull, gte, gt, lt } from "drizzle-orm";
import { getDb } from "@database/index";
import { authSessions, userRoles, users } from "@database/schema";
import { hashSecret } from "./crypto";
import { readCookie, SESSION_COOKIE } from "./sessions";
import { runtimeEnv } from "./runtime-env";
import { isLocalPreviewRequest } from "./access-boundary";

export type AccessContext = {
  sessionId: number | null;
  userId: number;
  email: string;
  name: string;
  roles: string[];
  factoryId: number | null;
  supplierId: number | null;
  organizationName: string;
  localPreview: boolean;
};

const INTERNAL_ROLES = new Set(["supply_chain", "finance", "admin", "company_qc"]);

export async function requireAccess(request: Request): Promise<AccessContext> {
  const localPreview = isLocalPreviewRequest({
    requestUrl: request.url,
    appEnv: runtimeEnv("APP_ENV"),
    deployTarget: runtimeEnv("DEPLOY_TARGET"),
    nodeEnv: runtimeEnv("NODE_ENV"),
  });
  const sessionToken = readCookie(request, SESSION_COOKIE);
  if (sessionToken) {
    const db = getDb();
    const [session] = await db.select().from(authSessions).where(and(
      eq(authSessions.tokenHash, await hashSecret(sessionToken)),
      isNull(authSessions.revokedAt),
      gt(authSessions.expiresAt, new Date().toISOString()),
    )).limit(1);
    if (session) {
      const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
      if (!user || user.accountStatus !== "active") throw new AccessError(403, "账号当前不可用。");
      await db.update(authSessions).set({ lastSeenAt: new Date().toISOString() }).where(eq(authSessions.id, session.id));
      return buildContext(user, false, session.id);
    }
  }
  if (localPreview) {
    return {
      sessionId: null,
      userId: 0,
      email: "preview@topologygz.com",
      name: "本地预览管理员",
      roles: ["admin", "supply_chain", "finance", "company_qc"],
      factoryId: null,
      supplierId: null,
      organizationName: "广州拓扑睡眠科技有限公司",
      localPreview: true,
    };
  }
  throw new AccessError(401, "请先登录后再访问系统。");
}

async function buildContext(user: typeof users.$inferSelect, localPreview: boolean, sessionId?: number): Promise<AccessContext> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.update(userRoles)
    .set({ status: "expired", updatedAt: new Date().toISOString() })
    .where(and(
      eq(userRoles.userId, user.id),
      eq(userRoles.status, "active"),
      isNotNull(userRoles.effectiveTo),
      lt(userRoles.effectiveTo, today),
    ));
  const roleRows = await db.select().from(userRoles).where(and(
    eq(userRoles.userId, user.id),
    eq(userRoles.status, "active"),
    or(isNull(userRoles.effectiveTo), gte(userRoles.effectiveTo, today)),
  ));
  return {
    sessionId: sessionId ?? null,
    userId: user.id,
    email: user.email,
    name: user.name,
    roles: Array.from(new Set([user.role, ...roleRows.map(row => row.roleCode)])),
    factoryId: user.factoryId ?? null,
    supplierId: user.supplierId ?? null,
    organizationName: user.organizationName,
    localPreview,
  };
}

export function requireRole(context: AccessContext, allowed: string[]) {
  if (!context.roles.some(role => allowed.includes(role))) {
    throw new AccessError(403, "当前账号没有执行此操作的权限。");
  }
}

export function isInternal(context: AccessContext) {
  return context.roles.some(role => INTERNAL_ROLES.has(role));
}

export class AccessError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "系统暂时无法处理请求。";
  return Response.json({ error: message }, { status: 500 });
}
