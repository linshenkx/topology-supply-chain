import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { retiredPlatformRoute } from "../../web/app/lib/retired-writer.ts";

const root = new URL("../../../", import.meta.url);
const rootPath = fileURLToPath(root);

const legacyBusinessGets = new Map([
  ["apps/web/app/api/approvals/route.ts", "/api/v1/approvals"],
  ["apps/web/app/api/audit-logs/route.ts", "/api/v1/audit-logs"],
  ["apps/web/app/api/finance/route.ts", "/api/v1/finance"],
  ["apps/web/app/api/imports/diff/route.ts", "/api/v1/imports/diff"],
  ["apps/web/app/api/inventory/route.ts", "/api/v1/inventory"],
  ["apps/web/app/api/master-data/route.ts", "/api/v1/master-data"],
  ["apps/web/app/api/production-orders/route.ts", "/api/v1/production-orders"],
  ["apps/web/app/api/purchase-orders/route.ts", "/api/v1/purchase-orders"],
  ["apps/web/app/api/purchase-plans/route.ts", "/api/v1/purchase-plans"],
  ["apps/web/app/api/quality-inspections/route.ts", "/api/v1/quality-inspections"],
  ["apps/web/app/api/returns/route.ts", "/api/v1/returns"],
  ["apps/web/app/api/shipments/route.ts", "/api/v1/shipments"],
  ["apps/web/app/api/stocktakes/route.ts", "/api/v1/stocktakes"],
  ["apps/web/app/api/supplier-performance/route.ts", "/api/v1/supplier-performance"],
  ["apps/web/app/api/supplier-prices/route.ts", "/api/v1/supplier-prices"],
  ["apps/web/app/api/supplier-skus/route.ts", "/api/v1/supplier-skus"],
  ["apps/web/app/api/suppliers/route.ts", "/api/v1/suppliers"],
  ["apps/web/app/api/warehouses/route.ts", "/api/v1/warehouses"],
]);

function getBody(source) {
  const start = source.search(/export async function GET\([^)]*\)\s*\{/u);
  assert.notEqual(start, -1);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  assert.fail("unterminated GET body");
}

async function enumerateGetRoutes(directory = new URL("apps/web/app/api/", root)) {
  const routes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) routes.push(...await enumerateGetRoutes(url));
    if (entry.isFile() && entry.name === "route.ts") {
      const source = await readFile(url, "utf8");
      if (/export (?:async function|const) GET/u.test(source)) {
        routes.push(path.relative(rootPath, fileURLToPath(url)).split(path.sep).join("/"));
      }
    }
  }
  return routes.sort();
}

test("all 18 legacy business GETs are 410-only without independent DB or authorization logic", async () => {
  const allGets = await enumerateGetRoutes();
  const enumeratedLegacyBusinessGets = allGets.filter((path) =>
    ![
      "apps/web/app/api/files/route.ts", "apps/web/app/api/health/route.ts",
      "apps/web/app/api/notifications/route.ts", "apps/web/app/api/session/route.ts",
      "apps/web/app/api/users/route.ts",
    ].includes(path),
  );
  assert.equal(legacyBusinessGets.size, 18);
  assert.deepEqual(enumeratedLegacyBusinessGets, [...legacyBusinessGets.keys()].sort());
  for (const [path, successor] of legacyBusinessGets) {
    const source = await readFile(new URL(path, root), "utf8");
    const body = getBody(source);
    assert.ok(body.includes(`retiredPlatformRoute("${successor}")`), path);
    assert.doesNotMatch(body, /getDb\(|requireAccess\(|requireRole\(|\.select\(|\.from\(|\.where\(|\.map\(|\.filter\(/u, path);
    const response = retiredPlatformRoute(successor);
    assert.equal(response.status, 410, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("link"), `<${successor}>; rel="successor-version"`, path);
    assert.deepEqual(await response.json(), {
      code: "WRITER_MOVED",
      message: "This platform route has moved to the v1 API writer.",
      migrationPath: successor,
    }, path);
  }
});

test("health and session remain outside the legacy business GET count", async () => {
  const [health, session] = await Promise.all([
    readFile(new URL("apps/web/app/api/health/route.ts", root), "utf8"),
    readFile(new URL("apps/web/app/api/session/route.ts", root), "utf8"),
  ]);
  assert.match(health, /export async function GET/u);
  assert.match(session, /export async function GET/u);
});
