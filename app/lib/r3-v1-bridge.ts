import { proxyDevelopmentApiV1Get, proxyDevelopmentApiV1Mutation } from "./v1-development-bridge";

export function r3Read(path: `/api/v1/${string}`) {
  return (request: Request) => proxyDevelopmentApiV1Get(request, {
    path,
    forwardSearch: true,
    requestTimeoutMs: 5_000,
    unavailableMessage: "API service unavailable",
  });
}

export function r3Mutation(path: `/api/v1/${string}`) {
  return (request: Request) => proxyDevelopmentApiV1Mutation(request, {
    path,
    requestTimeoutMs: 30_000,
    unavailableMessage: "API service unavailable",
  });
}
