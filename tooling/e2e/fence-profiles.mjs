import { createHash } from "node:crypto";

// Test-only, frozen resource sets. A scenario must choose one exact profile;
// this module intentionally has no "all resources" option.
export const E2E_FENCE_PROFILES = Object.freeze({
  "foundation-auth-worker": Object.freeze(["auth.commands", "outbox.worker"]),
  "t2-r2-master-data": Object.freeze(["r2.master-data.write"]),
  "t2-r2-suppliers": Object.freeze(["r2.suppliers.write", "r2.supplier-skus.write"]),
  "t2-r2-purchase-plan": Object.freeze(["r2.purchase-plans.create", "r2.purchase-plans.update"]),
  "t2-r2-purchase-order": Object.freeze(["r2.purchase-orders.create", "r2.purchase-orders.update"]),
  "t2-r3-inventory": Object.freeze(["r3.inventory.commands"]),
});

export function resolveFenceProfile(name = "foundation-auth-worker") {
  const resources = E2E_FENCE_PROFILES[name];
  if (!resources) throw new Error(`Unknown frozen E2E fence profile: ${name}`);
  return { name, resources: [...resources], sha256: createHash("sha256").update(JSON.stringify({ name, resources })).digest("hex") };
}
