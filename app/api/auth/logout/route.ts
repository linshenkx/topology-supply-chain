import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { authSessions } from "../../../../db/schema";
import { hashSecret } from "../../../lib/crypto";
import { readCookie, SESSION_COOKIE } from "../../../lib/sessions";

export async function POST(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await getDb().update(authSessions).set({ revokedAt: new Date().toISOString() }).where(eq(authSessions.tokenHash, await hashSecret(token)));
  return new Response(JSON.stringify({ success: true }), {
    headers: { "content-type": "application/json", "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
  });
}
