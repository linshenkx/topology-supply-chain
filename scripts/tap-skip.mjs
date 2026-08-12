const tapSkipDirective = /^\s*(?:not\s+)?ok\b[^\r\n]*#\s*SKIP\b/imu;
const tapSkipComment = /^\s*#\s*SKIP\b/imu;
const tapSkippedSummary = /^\s*#\s*skipped\s+([1-9]\d*)\s*$/imu;

export function tapHasSkips(output) {
  return tapSkipDirective.test(output)
    || tapSkipComment.test(output)
    || tapSkippedSummary.test(output);
}

export function assertTapHasNoSkips(output, label) {
  if (tapHasSkips(output)) throw new Error(`${label} reported a skipped test; skip is not a passing gate.`);
}
