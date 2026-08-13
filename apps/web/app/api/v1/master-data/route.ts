import { proxyDevelopmentApiV1Get } from "../../../lib/v1-development-bridge";

/**
 * Development-only GET bridge for the empty local preview response. Production
 * traffic is routed by Nginx. Do not add mutations or reuse this as a generic
 * proxy: future write paths must call the standalone API directly.
 */
export async function GET(request: Request) {
  return proxyDevelopmentApiV1Get(request, {
    path: "/api/v1/master-data",
    unavailableMessage: "Master data service unavailable",
  });
}
