import assert from "node:assert/strict";
import test from "node:test";

import { buildForwardedHeaders, routeTarget } from "../tooling/e2e/gateway-routing.mjs";

test("single Gateway routes exact /api/v1 and descendants to API, pages to Web", () => {
  const ports = { api: 3001, web: 3000 };
  assert.equal(routeTarget("/api/v1", ports), 3001);
  assert.equal(routeTarget("/api/v1/auth/login", ports), 3001);
  assert.equal(routeTarget("/", ports), 3000);
  assert.equal(routeTarget("/api/health", ports), 3000);
});

test("Gateway overwrites forwarded transport metadata and clears forged identity headers", () => {
  const headers = buildForwardedHeaders({
    host: "127.0.0.1:4000",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
    "oai-authenticated-user-email": "forged@example.com",
    cookie: "topology_session=token",
  }, "http");
  assert.equal(headers.host, "127.0.0.1:4000");
  assert.equal(headers["x-forwarded-host"], "127.0.0.1:4000");
  assert.equal(headers["x-forwarded-proto"], "http");
  assert.equal(headers["oai-authenticated-user-email"], undefined);
  assert.equal(headers.cookie, "topology_session=token");
});
