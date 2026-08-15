import { createHmac, timingSafeEqual } from "node:crypto";

import { CSRF_TOKEN_HEADER } from "@topology/contracts";
import type { FastifyRequest } from "fastify";

import { PlatformError } from "../errors.js";
const SESSION_COOKIE = "topology_session";
export const CSRF_COOKIE = "topology_csrf";

function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined || header.length > 8_192) return undefined;
  const matches: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function sameValue(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function requireSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string" && forwardedProto.length > 0
      ? forwardedProto.split(",")[0]?.trim()
      : request.protocol;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (
    typeof origin !== "string" ||
    typeof host !== "string" ||
    (protocol !== "http" && protocol !== "https")
  ) {
    throw new PlatformError(403, "ORIGIN_REJECTED", "Request origin rejected");
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new PlatformError(403, "ORIGIN_REJECTED", "Request origin rejected");
  }
  if (`${parsed.protocol}//${parsed.host}` !== `${protocol}://${host}`) {
    throw new PlatformError(403, "ORIGIN_REJECTED", "Request origin rejected");
  }
}

export function requireCsrf(request: FastifyRequest): void {
  const token = cookie(request, CSRF_COOKIE);
  const header = request.headers[CSRF_TOKEN_HEADER];
  if (
    token === undefined ||
    !/^[a-f\d]{64}$/iu.test(token) ||
    typeof header !== "string" ||
    !sameValue(token.toLowerCase(), header.toLowerCase())
  ) {
    throw new PlatformError(403, "CSRF_REJECTED", "CSRF validation failed");
  }
}

export function deriveSessionToken(
  signingKey: string,
  command: string,
  subjectDigest: string,
  idempotencyKey: string,
): string {
  if (signingKey.length < 32) throw new Error("SESSION_SIGNING_KEY is invalid");
  if (!/^[a-f\d]{64}$/u.test(subjectDigest)) throw new Error("SESSION_SUBJECT is invalid");
  return createHmac("sha256", signingKey)
    .update(`session:${command}:${subjectDigest}:${idempotencyKey}`, "utf8")
    .digest("hex");
}

export function deriveCsrfToken(signingKey: string, sessionToken: string): string {
  return createHmac("sha256", signingKey)
    .update(`csrf:${sessionToken}`, "utf8")
    .digest("hex");
}

export function csrfCookie(
  signingKey: string,
  sessionToken: string,
  maxAgeSeconds = 12 * 60 * 60,
  secure = true,
): string {
  return `${CSRF_COOKIE}=${deriveCsrfToken(signingKey, sessionToken)}; Path=/${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function sessionCookies(
  signingKey: string,
  sessionToken: string,
  maxAgeSeconds = 12 * 60 * 60,
  secure = true,
): string[] {
  return [
    `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
    csrfCookie(signingKey, sessionToken, maxAgeSeconds, secure),
  ];
}

export function clearSessionCookies(secure = true): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=0`,
  ];
}
