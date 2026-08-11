import { isLocalPreviewRequest } from "./access-boundary";

const API_V1_UPSTREAM_ORIGIN = "http://127.0.0.1:3001";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_REQUEST_ID_LENGTH = 200;
const SESSION_COOKIE = "topology_session";
const SESSION_TOKEN_PATTERN = /^[a-f\d]{64}$/iu;

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

  if (cookie !== null) headers.set("cookie", cookie);
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

  for (const name of ["content-disposition", "content-type", "x-request-id"]) {
    const value = response?.headers.get(name) ?? null;
    if (value !== null) headers.set(name, value);
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
