import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

const legacyBusinessGets = new Map([
  ["app/api/approvals/route.ts", "/api/v1/approvals"],
  ["app/api/audit-logs/route.ts", "/api/v1/audit-logs"],
  ["app/api/finance/route.ts", "/api/v1/finance"],
  ["app/api/imports/diff/route.ts", "/api/v1/imports/diff"],
  ["app/api/inventory/route.ts", "/api/v1/inventory"],
  ["app/api/master-data/route.ts", "/api/v1/master-data"],
  ["app/api/production-orders/route.ts", "/api/v1/production-orders"],
  ["app/api/purchase-orders/route.ts", "/api/v1/purchase-orders"],
  ["app/api/purchase-plans/route.ts", "/api/v1/purchase-plans"],
  ["app/api/quality-inspections/route.ts", "/api/v1/quality-inspections"],
  ["app/api/returns/route.ts", "/api/v1/returns"],
  ["app/api/shipments/route.ts", "/api/v1/shipments"],
  ["app/api/stocktakes/route.ts", "/api/v1/stocktakes"],
  ["app/api/supplier-performance/route.ts", "/api/v1/supplier-performance"],
  ["app/api/supplier-prices/route.ts", "/api/v1/supplier-prices"],
  ["app/api/supplier-skus/route.ts", "/api/v1/supplier-skus"],
  ["app/api/suppliers/route.ts", "/api/v1/suppliers"],
  ["app/api/warehouses/route.ts", "/api/v1/warehouses"],
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

async function enumerateGetRoutes(directory = new URL("app/api/", root)) {
  const routes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) routes.push(...await enumerateGetRoutes(url));
    if (entry.isFile() && entry.name === "route.ts") {
      const source = await readFile(url, "utf8");
      if (/export (?:async function|const) GET/u.test(source)) {
        routes.push(decodeURIComponent(url.pathname.split("/codex-software/")[1]).replaceAll("/", "\\"));
      }
    }
  }
  return routes.sort();
}

test("all 18 legacy business GETs are 410-only without independent DB or authorization logic", async () => {
  const allGets = await enumerateGetRoutes();
  const enumeratedLegacyBusinessGets = allGets.filter((path) =>
    !path.startsWith("app\\api\\v1\\") &&
    ![
      "app\\api\\files\\route.ts", "app\\api\\health\\route.ts",
      "app\\api\\notifications\\route.ts", "app\\api\\session\\route.ts",
      "app\\api\\users\\route.ts",
    ].includes(path),
  );
  assert.equal(legacyBusinessGets.size, 18);
  assert.deepEqual(enumeratedLegacyBusinessGets, [...legacyBusinessGets.keys()].map((path) => path.replaceAll("/", "\\")).sort());
  for (const [path, successor] of legacyBusinessGets) {
    const source = await readFile(new URL(path, root), "utf8");
    const body = getBody(source);
    assert.ok(body.includes(`retiredPlatformRoute("${successor}")`), path);
    assert.doesNotMatch(body, /getDb\(|requireAccess\(|requireRole\(|\.select\(|\.from\(|\.where\(|\.map\(|\.filter\(/u, path);
  }
});

test("health, session, and the development v1 bridge remain outside the legacy business GET count", async () => {
  const [health, session, bridge] = await Promise.all([
    readFile(new URL("app/api/health/route.ts", root), "utf8"),
    readFile(new URL("app/api/session/route.ts", root), "utf8"),
    readFile(new URL("app/api/v1/[...path]/route.ts", root), "utf8"),
  ]);
  assert.match(health, /export async function GET/u);
  assert.match(session, /export async function GET/u);
  assert.match(bridge, /proxyDevelopmentApiV1Get/u);
});
