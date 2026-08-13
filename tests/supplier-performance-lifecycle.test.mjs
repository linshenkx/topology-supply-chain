import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  buildSupplierPerformanceWeightCommand,
  loadSupplierPerformanceSnapshot,
} = await tsImport("../apps/web/app/lib/supplier-performance-lifecycle.ts", import.meta.url);

const root = new URL("../", import.meta.url);

const initialEffectFiles = new Map([
  ["apps/web/app/components/AuditWorkspace.tsx", 1],
  ["apps/web/app/components/FinanceExceptionWorkspace.tsx", 1],
  ["apps/web/app/components/FinanceWorkspace.tsx", 1],
  ["apps/web/app/components/InventoryWorkspace.tsx", 1],
  ["apps/web/app/components/ProductionWorkspace.tsx", 1],
  ["apps/web/app/components/PurchaseWorkspace.tsx", 1],
  ["apps/web/app/components/ShippingWorkspace.tsx", 1],
  ["apps/web/app/components/StocktakeWorkspace.tsx", 1],
  ["apps/web/app/components/SupplierPerformanceWorkspace.tsx", 1],
  ["apps/web/app/components/SupplierPriceWorkspace.tsx", 1],
  ["apps/web/app/components/SupplierWorkspace.tsx", 1],
  ["apps/web/app/components/WarehouseWorkspace.tsx", 1],
  ["apps/web/app/page.tsx", 2],
]);

test("all 14 initial request effects abort during cleanup without async wrappers", async () => {
  let effects = 0;
  for (const [path, expected] of initialEffectFiles) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(source, /loadInitialData/u, path);
    const controllers = source.match(/const controller\s*=\s*new AbortController\(\)/gu)?.length ?? 0;
    const cleanups = source.match(/return\s*\(\)\s*=>\s*controller\.abort\(\)/gu)?.length ?? 0;
    assert.equal(controllers, expected, `${path} controller count`);
    assert.equal(cleanups, expected, `${path} cleanup count`);
    effects += expected;
  }
  assert.equal(effects, 14);
});

function deferredResponse(payload) {
  let resolve;
  const response = new Promise(next => { resolve = next; });
  return {
    fetcher: () => response,
    resolve: () => resolve(new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
      status: 200,
    })),
  };
}

function payload(tier, delivery) {
  return {
    automaticMetricsPending: false,
    canConfigure: true,
    canReview: true,
    quarter: "2026-Q3",
    rankings: [{ displayName: `tier-${tier}`, supplierId: tier }],
    weights: [{
      delivery,
      exception: 1_500,
      preparation: 1_000,
      quality: 2_000,
      sampling: 1_500,
      satisfaction: tier === 1 ? 1_500 : 0,
      tier,
    }],
  };
}

test("slow tier 1 cannot replace tier 2 UI or be saved as tier 2 weights", async () => {
  const slowTier1 = deferredResponse(payload(1, 2_500));
  const fastTier2 = deferredResponse(payload(2, 4_000));
  const tier1Controller = new AbortController();
  const tier1Request = loadSupplierPerformanceSnapshot({
    fetcher: slowTier1.fetcher,
    quarter: "2026-Q3",
    signal: tier1Controller.signal,
    tier: 1,
  });

  tier1Controller.abort();
  const tier2Controller = new AbortController();
  const tier2Request = loadSupplierPerformanceSnapshot({
    fetcher: fastTier2.fetcher,
    quarter: "2026-Q3",
    signal: tier2Controller.signal,
    tier: 2,
  });

  fastTier2.resolve();
  const tier2Result = await tier2Request;
  assert.equal(tier2Result.kind, "success");
  let ui = tier2Result.snapshot;
  assert.equal(ui.tier, 2);
  assert.equal(ui.payload.rankings[0].displayName, "tier-2");
  assert.equal(ui.weights.delivery, 40);

  slowTier1.resolve();
  const tier1Result = await tier1Request;
  assert.equal(tier1Result.kind, "stale");
  if (tier1Result.kind === "success") ui = tier1Result.snapshot;
  assert.equal(ui.tier, 2);
  assert.equal(ui.payload.rankings[0].displayName, "tier-2");

  const command = buildSupplierPerformanceWeightCommand(
    ui.weights,
    { quarter: ui.quarter, tier: ui.tier },
    { quarter: "2026-Q3", tier: 2 },
    "2026-08-13",
  );
  assert.equal(command.tier, 2);
  assert.equal(command.delivery, 40);
  assert.equal(command.effectiveFrom, "2026-08-13");
  assert.throws(
    () => buildSupplierPerformanceWeightCommand(
      { ...ui.weights, tier: 1 },
      { quarter: "2026-Q3", tier: 1 },
      { quarter: "2026-Q3", tier: 2 },
      "2026-08-13",
    ),
    /当前层级权重仍在加载/u,
  );
});
