export const INVENTORY_TRANSFER_TRANSITIONS = {
  ship: { from: "approved", to: "shipped" },
  receive: { from: "shipped", to: "received" },
} as const;

type InventoryBatchSnapshot = {
  id: number;
  availableQuantity: number;
};

export function mutationAffectedExactlyOnce(affected: number) {
  return affected === 1;
}

export function planInventoryTransferDeductions(
  batches: readonly InventoryBatchSnapshot[],
  requiredQuantity: number,
) {
  if (!Number.isSafeInteger(requiredQuantity) || requiredQuantity < 0) {
    throw new RangeError("调拨数量必须为非负安全整数。");
  }

  let remaining = requiredQuantity;
  const deductions: Array<{ batchId: number; quantity: number }> = [];
  for (const batch of batches) {
    if (remaining === 0) break;
    const available = Number.isSafeInteger(batch.availableQuantity)
      ? Math.max(0, batch.availableQuantity)
      : 0;
    const quantity = Math.min(remaining, available);
    if (quantity === 0) continue;
    deductions.push({ batchId: batch.id, quantity });
    remaining -= quantity;
  }

  return { deductions, remaining };
}
