export function evaluateInspection(input: {
  inspectedQuantity: number;
  passedQuantity: number;
  minimumPassRateBps?: number;
  inspectionMethod: "sampling" | "full";
}) {
  const minimumPassRateBps = input.minimumPassRateBps ?? 9500;
  if (
    !Number.isInteger(input.inspectedQuantity) ||
    !Number.isInteger(input.passedQuantity) ||
    input.inspectedQuantity <= 0 ||
    input.passedQuantity < 0 ||
    input.passedQuantity > input.inspectedQuantity
  ) {
    throw new Error("质检数量不合法。");
  }
  const passRateBps = Math.round(
    (input.passedQuantity / input.inspectedQuantity) * 10000,
  );
  const passed = passRateBps >= minimumPassRateBps;
  return {
    passRateBps,
    minimumPassRateBps,
    systemResult: passed ? ("passed" as const) : ("failed" as const),
    quarantineTriggered: !passed,
    fullInspectionRequired: !passed && input.inspectionMethod === "sampling",
  };
}

export function calculateReservation(
  availableQuantity: number,
  requestedQuantity: number,
) {
  if (
    !Number.isInteger(availableQuantity) ||
    !Number.isInteger(requestedQuantity) ||
    availableQuantity < 0 ||
    requestedQuantity <= 0
  ) {
    throw new Error("库存数量不合法。");
  }
  const reservedQuantity = Math.min(availableQuantity, requestedQuantity);
  return {
    reservedQuantity,
    shortageQuantity: requestedQuantity - reservedQuantity,
    canReserveInFull: availableQuantity >= requestedQuantity,
  };
}

export function calculateExpiryStatus(input: {
  productionDate: string;
  expiryDate: string;
  today: string;
}) {
  const production = Date.parse(`${input.productionDate}T00:00:00Z`);
  const expiry = Date.parse(`${input.expiryDate}T00:00:00Z`);
  const today = Date.parse(`${input.today}T00:00:00Z`);
  if (![production, expiry, today].every(Number.isFinite) || expiry <= production) {
    throw new Error("生产日期或到期日期不合法。");
  }
  if (today >= expiry) return "expired_frozen" as const;
  const totalLife = expiry - production;
  const remaining = expiry - today;
  if (remaining <= totalLife / 4) return "red" as const;
  if (remaining <= totalLife / 2) return "yellow" as const;
  return "normal" as const;
}

export function calculatePlannedPaymentDate(input: {
  shippedAt: string;
  mode: "shipment_plus_days" | "monthly_cutoff";
  daysAfterShipment?: number | null;
  cutoffDay?: number | null;
  paymentDay?: number | null;
}) {
  const shipped = new Date(input.shippedAt);
  if (!Number.isFinite(shipped.getTime())) throw new Error("实际发货日期不合法。");
  if (input.mode === "shipment_plus_days") {
    const days = Number(input.daysAfterShipment);
    if (!Number.isInteger(days) || days < 0) throw new Error("发货后付款天数不合法。");
    shipped.setUTCDate(shipped.getUTCDate() + days);
    return shipped.toISOString().slice(0, 10);
  }
  const cutoffDay = input.cutoffDay ?? 25;
  const paymentDay = input.paymentDay ?? 25;
  if (cutoffDay < 1 || cutoffDay > 31 || paymentDay < 1 || paymentDay > 31) {
    throw new Error("月结付款日期配置不合法。");
  }
  const monthOffset = shipped.getUTCDate() <= cutoffDay ? 1 : 2;
  const target = new Date(Date.UTC(
    shipped.getUTCFullYear(),
    shipped.getUTCMonth() + monthOffset,
    1,
  ));
  const lastDay = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  target.setUTCDate(Math.min(paymentDay, lastDay));
  return target.toISOString().slice(0, 10);
}

export function toMysqlDateTime(value: string) {
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!isoDateTime.test(value)) return value;
  return value.replace("T", " ").replace(/Z$/, "");
}
