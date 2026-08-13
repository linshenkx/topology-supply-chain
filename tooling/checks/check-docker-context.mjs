import { readFile } from "node:fs/promises";

const dockerignore = await readFile(new URL("../../.dockerignore", import.meta.url), "utf8");
const rules = new Set(dockerignore.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
const required = [
  ".git",
  ".github",
  ".next",
  ".vinext",
  ".wrangler",
  ".pnpm-store",
  ".tmp",
  "archive",
  "backups",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
  "topology-scm-*.tar.gz",
  "work",
  "*.tsbuildinfo",
  "*.zip",
];
const missing = required.filter((rule) => !rules.has(rule));
if (missing.length) {
  console.error(`Docker context exclusions missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Docker context contract covers ${required.length} archive/cache/generated exclusions.`);
