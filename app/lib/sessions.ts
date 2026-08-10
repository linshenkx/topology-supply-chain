import { getDb } from "../../db";
import { authSessions } from "../../db/schema";
import { hashSecret, randomToken } from "./crypto";

export const SESSION_COOKIE = "topology_session";

export async function createSession(input: { userId: number; deviceId: string; ipAddress?: string | null; region?: string | null }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 12 * 3600000);
  await getDb().insert(authSessions).values({
    userId: input.userId, tokenHash: await hashSecret(token), deviceId: input.deviceId,
    ipAddress: input.ipAddress, region: input.region, expiresAt: expiresAt.toISOString(),
  });
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${12 * 3600}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
