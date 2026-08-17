import { createHash } from "node:crypto";

// Test-only, frozen resource sets. A scenario must choose one exact profile;
// this module intentionally has no "all resources" option.
export const E2E_FENCE_PROFILES = Object.freeze({
  "foundation-auth-worker": Object.freeze(["auth.commands", "outbox.worker"]),
  "t2-account-lifecycle": Object.freeze(["auth.commands", "users.commands", "outbox.worker"]),
  "t2-supply-master-data": Object.freeze(["auth.commands", "outbox.worker", "r2.master-data.write"]),
  "t2-supply-suppliers": Object.freeze(["auth.commands", "outbox.worker", "r2.suppliers.write", "r2.supplier-skus.write"]),
  "t2-supply-purchase-plan": Object.freeze(["auth.commands", "outbox.worker", "r2.purchase-plans.create", "r2.purchase-plans.update"]),
  "t2-supply-purchase-order": Object.freeze(["auth.commands", "outbox.worker", "r2.purchase-orders.create", "r2.purchase-orders.update"]),
  "t2-operations-inventory": Object.freeze(["auth.commands", "outbox.worker", "r3.inventory.commands", "r3.transfers.commands", "r3.stocktakes.commands"]),
  "t2-operations-production-quality": Object.freeze(["auth.commands", "outbox.worker", "r3.production-orders.commands", "r3.quality-inspections.commands"]),
  "t2-operations-scope-a-closures": Object.freeze(["auth.commands", "outbox.worker", "r3.purchase-receipts.commands", "r3.quality-inspections.commands", "r3.inventory.commands", "r3.production-orders.commands"]),
  "t2-operations-logistics": Object.freeze(["auth.commands", "outbox.worker", "r3.shipments.commands", "r3.returns.commands"]),
  "t2-operations-finance": Object.freeze(["auth.commands", "outbox.worker", "r3.finance.commands"]),
});

export function resolveFenceProfile(name = "foundation-auth-worker") {
  const resources = E2E_FENCE_PROFILES[name];
  if (!resources) throw new Error(`Unknown frozen E2E fence profile: ${name}`);
  return { name, resources: [...resources], sha256: createHash("sha256").update(JSON.stringify({ name, resources })).digest("hex") };
}
