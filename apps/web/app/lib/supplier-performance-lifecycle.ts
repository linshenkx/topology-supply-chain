export type SupplierPerformanceMetricKey = "delivery" | "quality" | "exception" | "preparation" | "satisfaction" | "sampling";
export type SupplierPerformanceWeight = Record<SupplierPerformanceMetricKey, number> & { tier: number };
export type SupplierPerformanceSelection = { quarter: string; tier: number };

type PerformancePayload = {
  weights: SupplierPerformanceWeight[];
};

export type SupplierPerformanceSnapshot<Payload extends PerformancePayload> = SupplierPerformanceSelection & {
  payload: Payload;
  weights: SupplierPerformanceWeight | null;
};

export type SupplierPerformanceLoadResult<Payload extends PerformancePayload> =
  | { kind: "success"; snapshot: SupplierPerformanceSnapshot<Payload> }
  | { kind: "error"; message: string }
  | { kind: "stale" };

export async function loadSupplierPerformanceSnapshot<Payload extends PerformancePayload>({
  fetcher = fetch,
  quarter,
  signal,
  tier,
}: SupplierPerformanceSelection & {
  fetcher?: typeof fetch;
  signal: AbortSignal;
}): Promise<SupplierPerformanceLoadResult<Payload>> {
  const response = await fetcher(`/api/v1/supplier-performance?quarter=${encodeURIComponent(quarter)}&tier=${tier}`, { signal });
  const payload = await response.json() as Payload & { error?: string };
  if (signal.aborted) return { kind: "stale" };
  if (!response.ok) return { kind: "error", message: payload.error || "绩效数据加载失败" };
  const current = payload.weights.find(item => item.tier === tier);
  const weights = current === undefined ? null : {
    ...current,
    delivery: current.delivery / 100,
    quality: current.quality / 100,
    exception: current.exception / 100,
    preparation: current.preparation / 100,
    satisfaction: current.satisfaction / 100,
    sampling: current.sampling / 100,
  };
  return { kind: "success", snapshot: { payload, quarter, tier, weights } };
}

export function isSupplierPerformanceSelectionCurrent(
  loaded: SupplierPerformanceSelection | null,
  current: SupplierPerformanceSelection,
): boolean {
  return loaded?.quarter === current.quarter && loaded.tier === current.tier;
}

export function buildSupplierPerformanceWeightCommand(
  weights: SupplierPerformanceWeight,
  loaded: SupplierPerformanceSelection | null,
  current: SupplierPerformanceSelection,
  effectiveFrom: string,
): { action: "weights"; effectiveFrom: string } & SupplierPerformanceWeight {
  if (!isSupplierPerformanceSelectionCurrent(loaded, current) || weights.tier !== current.tier) {
    throw new Error("当前层级权重仍在加载，请稍后重试");
  }
  return { action: "weights", ...weights, effectiveFrom };
}
