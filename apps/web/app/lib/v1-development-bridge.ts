import { isLocalPreviewRequest } from "./access-boundary";

const API_V1_UPSTREAM_ORIGIN = "http://127.0.0.1:3001";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_REQUEST_ID_LENGTH = 200;
const ALLOWED_COOKIES = new Set(["topology_session", "topology_csrf"]);

export interface DevelopmentGetBridgeOptions {
  path: `/api/v1/${string}`;
  forwardSearch?: boolean;
  requestTimeoutMs?: number;
  unavailableMessage: string;
}

function proxyAllowed(request: Request): boolean {
  return isLocalPreviewRequest({
    requestUrl: request.url,
    appEnv: process.env.APP_ENV,
    deployTarget: process.env.DEPLOY_TARGET,
    nodeEnv: process.env.NODE_ENV,
  });
}

function safeCookies(cookieHeader: string | null): string | null {
  if (
    cookieHeader === null ||
    cookieHeader.length > MAX_COOKIE_HEADER_LENGTH
  ) {
    return null;
  }

  const matches: string[] = [];
  const names = new Set<string>();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!ALLOWED_COOKIES.has(name)) continue;
    if (names.has(name)) return null;
    names.add(name);
    const value = part.slice(separator + 1).trim();
    if (!/^[a-f\d]{64}$/iu.test(value)) return null;
    matches.push(`${name}=${value}`);
  }
  return matches.length > 0 ? matches.join("; ") : null;
}

function requestHeaders(request: Request, publicUrl?: URL): Headers {
  const headers = new Headers({ accept: "application/json" });
  const cookie = safeCookies(request.headers.get("cookie"));
  const requestId = request.headers.get("x-request-id");

  if (cookie !== null) headers.set("cookie", cookie);
  if (requestId !== null && requestId.length <= MAX_REQUEST_ID_LENGTH) {
    headers.set("x-request-id", requestId);
  }
  for (const name of ["content-type", "idempotency-key", "x-csrf-token", "x-request-digest"]) {
    const value = request.headers.get(name);
    if (value !== null && value.length <= 512) headers.set(name, value);
  }
  if (publicUrl !== undefined) {
    headers.set("origin", publicUrl.origin);
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1));
  }

  return headers;
}

function responseHeaders(response?: Response): Headers {
  const headers = new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
    vary: "Cookie",
  });

  for (const name of ["content-disposition", "content-type", "x-request-id"]) {
    const value = response?.headers.get(name) ?? null;
    if (value !== null) headers.set(name, value);
  }
  const setCookies = response === undefined ? [] :
    ((response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [response.headers.get("set-cookie")].filter((value): value is string => value !== null));
  for (const value of setCookies) {
    if (/^(topology_session|topology_csrf)=/u.test(value)) headers.append("set-cookie", value);
  }

  return headers;
}

function notFound(): Response {
  return Response.json(
    { error: "Not Found" },
    { status: 404, headers: responseHeaders() },
  );
}

/**
 * Development-only, GET-only bridge to the standalone API. The caller must
 * supply an exact allowlisted path; the upstream origin is never derived from
 * request input and identity headers are never forwarded.
 */
export async function proxyDevelopmentApiV1Get(
  request: Request,
  options: DevelopmentGetBridgeOptions,
): Promise<Response> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return notFound();
  }

  if (!proxyAllowed(request) || requestUrl.pathname !== options.path) {
    return notFound();
  }

  const upstreamUrl = new URL(options.path, API_V1_UPSTREAM_ORIGIN);
  if (options.forwardSearch === true) upstreamUrl.search = requestUrl.search;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: requestHeaders(request),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch {
    return Response.json(
      { error: options.unavailableMessage },
      { status: 502, headers: responseHeaders() },
    );
  }
}

export async function proxyDevelopmentApiV1Mutation(
  request: Request,
  options: DevelopmentGetBridgeOptions,
): Promise<Response> {
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { return notFound(); }
  if (!proxyAllowed(request) || requestUrl.pathname !== options.path ||
      !["POST", "PATCH", "DELETE"].includes(request.method)) return notFound();
  const browserOrigin = request.headers.get("origin");
  if (browserOrigin === null) return notFound();
  try {
    if (new URL(browserOrigin).origin !== requestUrl.origin) return notFound();
  } catch {
    return notFound();
  }
  const upstreamUrl = new URL(options.path, API_V1_UPSTREAM_ORIGIN);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      // proxyAllowed proves requestUrl is non-production loopback. Rebuild the
      // public origin from that trusted URL instead of forwarding Host input.
      headers: requestHeaders(request, requestUrl),
      body: await request.arrayBuffer(),
      redirect: "manual",
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream) });
  } catch {
    return Response.json({ error: options.unavailableMessage }, { status: 502, headers: responseHeaders() });
  }
}
