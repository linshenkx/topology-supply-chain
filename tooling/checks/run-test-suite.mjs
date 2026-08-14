import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { assertTapHasNoSkips } from "./tap-skip.mjs";

const root = resolve(import.meta.dirname, "../..");
const locations = ["tests", "apps/api/test", "apps/worker/test"];
const suite = process.argv[2];
const supported = new Set(["root", "api", "worker", "non-mysql", "mysql"]);

if (!supported.has(suite)) {
  console.error(`Usage: node tooling/checks/run-test-suite.mjs <${[...supported].join("|")}>`);
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
const e2eIntegration = (name) => name.startsWith("e2e-") && integration(name);
const mysqlIntegration = (name) => integration(name) && !e2eIntegration(name);
const files = locationForSuite[suite]
  .flatMap((directory) => readdirSync(resolve(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .filter((entry) => entry.name !== "rendered-html.test.mjs")
    .filter((entry) => suite === "mysql" ? mysqlIntegration(entry.name) : !integration(entry.name))
    .map((entry) => relative(root, resolve(root, directory, entry.name)).replaceAll("\\", "/")))
  .sort();

if (suite === "mysql") {
  const required = [
    "MYSQL_ADMIN_TEST_URL",
    "TEST_DATABASE_URL",
    "MYSQL_WRITE_TEST_URL",
    "MYSQL_SUPPLY_TEST_URL",
    "MYSQL_OPERATIONS_TEST_URL",
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
  "--experimental-strip-types",
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
try {
  assertTapHasNoSkips(result.stdout ?? "", `Suite ${suite}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
