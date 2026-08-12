import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const locations = ["tests", "apps/api/test", "apps/worker/test"];
const suite = process.argv[2];
const supported = new Set(["root", "api", "worker", "non-mysql", "mysql"]);

if (!supported.has(suite)) {
  console.error(`Usage: node scripts/run-test-suite.mjs <${[...supported].join("|")}>`);
  process.exit(2);
}

const locationForSuite = {
  root: ["tests"],
  api: ["apps/api/test"],
  worker: ["apps/worker/test"],
  "non-mysql": locations,
  mysql: locations,
};

const integration = (name) => name.endsWith(".integration.test.mjs");
const files = locationForSuite[suite]
  .flatMap((directory) => readdirSync(resolve(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .filter((entry) => entry.name !== "rendered-html.test.mjs")
    .filter((entry) => suite === "mysql" ? integration(entry.name) : !integration(entry.name))
    .map((entry) => relative(root, resolve(root, directory, entry.name)).replaceAll("\\", "/")))
  .sort();

if (suite === "mysql") {
  const required = [
    "MYSQL_ADMIN_TEST_URL",
    "TEST_DATABASE_URL",
    "MYSQL_WRITE_TEST_URL",
    "MYSQL_R2_TEST_URL",
    "MYSQL_R3_TEST_URL",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    console.error(`MySQL integration gate requires: ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (!files.length) {
  console.error(`No test files selected for suite ${suite}`);
  process.exit(1);
}

console.log(`Running ${suite} suite (${files.length} files, skip is forbidden).`);
const result = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  "--test-reporter=tap",
  ...files,
], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 32 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (/(?:^|\n)\s*# SKIP\b/iu.test(result.stdout ?? "")) {
  console.error(`Suite ${suite} reported a skipped test; skip is not a passing gate.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
