export const STEP_UP_TTL_MS = 5 * 60_000;
export const PREVIEW_STEP_UP_CHALLENGE = "preview-high-risk";
export const PREVIEW_STEP_UP_CODE = "123456";

const STEP_UP_SCOPE_PATTERN = /^(?:approval|finance:(?:record_payment|request_record_correction|release_invoice_risk)):[1-9]\d{0,9}$/;

export function normalizeStepUpScope(value: unknown) {
  if (typeof value !== "string") return null;
  const scope = value.trim();
  if (scope.length > 96 || !STEP_UP_SCOPE_PATTERN.test(scope)) return null;
  const entityId = Number(scope.slice(scope.lastIndexOf(":") + 1));
  return Number.isSafeInteger(entityId) && entityId > 0 ? scope : null;
}

export function isPreviewStepUpVerification(challengeNo: unknown, code: unknown) {
  return challengeNo === PREVIEW_STEP_UP_CHALLENGE && code === PREVIEW_STEP_UP_CODE;
}
