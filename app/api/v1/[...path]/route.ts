import { proxyDevelopmentApiV1Get, proxyDevelopmentApiV1Mutation } from "../../../lib/v1-development-bridge";

const STAGE4_READ_PATHS = new Set<string>([
  "/api/v1/approvals",
  "/api/v1/audit-logs",
  "/api/v1/files",
  "/api/v1/files/status",
  "/api/v1/finance",
  "/api/v1/imports/diff",
  "/api/v1/inventory",
  "/api/v1/notifications",
  "/api/v1/production-orders",
  "/api/v1/purchase-orders",
  "/api/v1/purchase-plans",
  "/api/v1/quality-inspections",
  "/api/v1/returns",
  "/api/v1/session",
  "/api/v1/shipments",
  "/api/v1/stocktakes",
  "/api/v1/supplier-performance",
  "/api/v1/supplier-prices",
  "/api/v1/supplier-skus",
  "/api/v1/suppliers",
  "/api/v1/users",
  "/api/v1/warehouses",
]);

const LONG_RUNNING_READ_PATHS = new Set<string>([
  "/api/v1/audit-logs",
  "/api/v1/files",
  "/api/v1/supplier-performance",
]);
const WRITE_PATHS = new Set<string>([
  "/api/v1/auth/login", "/api/v1/auth/verify", "/api/v1/auth/logout",
  "/api/v1/auth/step-up/request", "/api/v1/auth/step-up/verify",
  "/api/v1/users", "/api/v1/files", "/api/v1/notifications/read",
]);

/**
 * Local-development bridge for the Stage 4 read allowlist. Production Nginx
 * routes `/api/v1/*` directly to Fastify, and this route refuses production.
 */
export async function GET(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (!STAGE4_READ_PATHS.has(pathname)) {
    return Response.json(
      { error: "Not Found" },
      {
        status: 404,
        headers: {
          "cache-control": "private, no-store",
          pragma: "no-cache",
          vary: "Cookie",
        },
      },
    );
  }

  return proxyDevelopmentApiV1Get(request, {
    path: pathname as `/api/v1/${string}`,
    forwardSearch: true,
    requestTimeoutMs: LONG_RUNNING_READ_PATHS.has(pathname) ? 30_000 : 5_000,
    unavailableMessage: "API service unavailable",
  });
}

async function mutation(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (!WRITE_PATHS.has(pathname)) return Response.json({ error: "Not Found" }, { status: 404 });
  return proxyDevelopmentApiV1Mutation(request, {
    path: pathname as `/api/v1/${string}`,
    requestTimeoutMs: pathname === "/api/v1/files" ? 30_000 : 10_000,
    unavailableMessage: "API service unavailable",
  });
}

export const POST = mutation;
export const PATCH = mutation;
export const DELETE = mutation;
