import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const policy = JSON.parse(
  await readFile(new URL("./stage9-t2-audit-policy.json", import.meta.url), "utf8"),
);
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("npm_execpath is required to run the pinned pnpm audit command.");

function audit(args) {
  const result = spawnSync(process.execPath, [pnpmEntry, "audit", ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    throw new Error(`pnpm audit ${args.join(" ")} returned no JSON: ${result.stderr}`);
  }
  return { report: JSON.parse(result.stdout), exitCode: result.status };
}

const today = new Date().toISOString().slice(0, 10);
if (today >= policy.reviewBy) {
  throw new Error(`Stage 9 T2 upstream audit exceptions require review by ${policy.reviewBy}.`);
}

const production = audit(["--prod"]);
const productionCounts = production.report.metadata.vulnerabilities;
const productionTotal = Object.values(productionCounts).reduce((sum, count) => sum + count, 0);
if (production.exitCode !== 0 || productionTotal !== 0) {
  throw new Error(`Production audit is not clean: ${JSON.stringify(productionCounts)}.`);
}

const full = audit([]);
const fullCounts = full.report.metadata.vulnerabilities;
if (fullCounts.critical !== 0) {
  throw new Error(`Full-tree audit has ${fullCounts.critical} Critical vulnerabilities.`);
}

const actualHigh = Object.values(full.report.advisories)
  .filter((advisory) => advisory.severity === "high")
  .flatMap((advisory) =>
    advisory.findings.map((finding) => ({
      githubAdvisoryId: advisory.github_advisory_id,
      module: advisory.module_name,
      severity: advisory.severity,
      installedVersion: finding.version,
      dependencyPaths: [...finding.paths].sort(),
      dev: finding.dev,
    })),
  )
  .sort((left, right) => left.githubAdvisoryId.localeCompare(right.githubAdvisoryId));
const expectedHigh = policy.exceptions
  .map((entry) => ({
    githubAdvisoryId: entry.githubAdvisoryId,
    module: entry.module,
    severity: entry.severity,
    installedVersion: entry.installedVersion,
    dependencyPaths: [entry.dependencyPath],
    dev: true,
  }))
  .sort((left, right) => left.githubAdvisoryId.localeCompare(right.githubAdvisoryId));

if (JSON.stringify(actualHigh) !== JSON.stringify(expectedHigh)) {
  throw new Error(
    `Full-tree High findings differ from the adjudicated upstream exceptions.\nExpected: ${JSON.stringify(expectedHigh)}\nActual: ${JSON.stringify(actualHigh)}`,
  );
}
if (fullCounts.high !== expectedHigh.length) {
  throw new Error(`Full-tree audit reports ${fullCounts.high} High findings; expected ${expectedHigh.length}.`);
}

console.log(`Production audit: ${JSON.stringify(productionCounts)}.`);
console.log(`Full-tree audit: ${JSON.stringify(fullCounts)}.`);
console.log(
  `Verified ${expectedHigh.length} exact dev-only upstream exceptions (${expectedHigh.map((entry) => entry.githubAdvisoryId).join(", ")}); review by ${policy.reviewBy}.`,
);
