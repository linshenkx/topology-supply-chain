import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";

const root = resolve(import.meta.dirname, "..");
const baselineUrl = new URL("../tests/fixtures/eslint-baseline.json", import.meta.url);
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(["."]);
const entries = new Map();
let errors = 0;
let warnings = 0;

for (const result of results) {
  const file = relative(root, result.filePath).replaceAll("\\", "/");
  errors += result.errorCount;
  warnings += result.warningCount;
  for (const message of result.messages) {
    if (message.severity !== 1 && message.severity !== 2) continue;
    const severity = message.severity === 2 ? "error" : "warning";
    const key = `${file}::${severity}::${message.ruleId ?? "<parser>"}`;
    entries.set(key, (entries.get(key) ?? 0) + 1);
  }
}

const actual = Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
if (process.argv.includes("--print")) {
  console.log(JSON.stringify({ version: 1, errors, warnings, entries: actual }, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
const unfrozenWarnings = Object.keys(baseline.entries)
  .filter((key) => key.includes("::warning::"))
  .filter((key) => typeof baseline.warningReasons?.[key] !== "string" || baseline.warningReasons[key].trim() === "");
if (unfrozenWarnings.length) {
  console.error("Frozen warning entries require a non-empty, entry-specific reason:");
  for (const key of unfrozenWarnings) console.error(`- ${key}`);
  process.exit(1);
}
const regressions = Object.entries(actual)
  .filter(([key, count]) => count > (baseline.entries[key] ?? 0))
  .map(([key, count]) => `${key}: ${count} > ${baseline.entries[key] ?? 0}`);

console.log(`ESLint source baseline: ${errors} errors, ${warnings} warnings.`);
if (regressions.length) {
  console.error("New lint debt exceeds the frozen file/rule baseline:");
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}

const retired = Object.keys(baseline.entries).filter((key) => !(key in actual));
if (errors < baseline.errors || warnings < baseline.warnings || retired.length) {
  console.log(`Lint debt decreased; refresh the baseline in the same focused quality change (${retired.length} retired entries).`);
}
