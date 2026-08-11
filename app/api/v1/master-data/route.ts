import { isLocalPreviewRequest } from "../../../lib/access-boundary";

const MASTER_DATA_UPSTREAM =
  "http://127.0.0.1:3001/api/v1/master-data" as const;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_REQUEST_ID_LENGTH = 200;
const SESSION_COOKIE = "topology_session";
const SESSION_TOKEN_PATTERN = /^[a-f\d]{64}$/iu;

function proxyAllowed(request: Request): boolean {
  return isLocalPreviewRequest({
    requestUrl: request.url,
    appEnv: process.env.APP_ENV,
    deployTarget: process.env.DEPLOY_TARGET,
    nodeEnv: process.env.NODE_ENV,
  });
}

function sessionCookie(cookieHeader: string | null): string | null {
  if (
    cookieHeader === null ||
    cookieHeader.length > MAX_COOKIE_HEADER_LENGTH
  ) {
    return null;
  }

  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;

    matches.push(part.slice(separator + 1).trim());
  }

  const token = matches[0];
  return matches.length === 1 &&
    token !== undefined &&
    SESSION_TOKEN_PATTERN.test(token)
    ? `${SESSION_COOKIE}=${token}`
    : null;
}

function requestHeaders(request: Request): Headers {
  const headers = new Headers({ accept: "application/json" });
  const cookie = sessionCookie(request.headers.get("cookie"));
  const requestId = request.headers.get("x-request-id");

  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  if (requestId !== null && requestId.length <= MAX_REQUEST_ID_LENGTH) {
    headers.set("x-request-id", requestId);
  }

  return headers;
}

function responseHeaders(response?: Response): Headers {
  const headers = new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
    vary: "Cookie",
  });
  const contentType = response?.headers.get("content-type") ?? null;
  const requestId = response?.headers.get("x-request-id") ?? null;

  if (contentType !== null) headers.set("content-type", contentType);
  if (requestId !== null) headers.set("x-request-id", requestId);
  return headers;
}

/**
 * Development-only GET bridge for the empty local preview response. Production
 * traffic is routed by Nginx. Do not add mutations or reuse this as a generic
 * proxy: future write paths must call the standalone API directly.
 */
export async function GET(request: Request) {
  if (!proxyAllowed(request)) {
    return Response.json(
      { error: "Not Found" },
      { status: 404, headers: responseHeaders() },
    );
  }

  try {
    const upstream = await fetch(MASTER_DATA_UPSTREAM, {
      method: "GET",
      headers: requestHeaders(request),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch {
    return Response.json(
      { error: "Master data service unavailable" },
      { status: 502, headers: responseHeaders() },
    );
  }
}
