import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ENVIRONMENT_CONTRACT } from "./environment-contract.mjs";

const localTemplate = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
const productionTemplate = await readFile(new URL("../../infrastructure/aliyun/.env.production.template", import.meta.url), "utf8");
const compose = await readFile(new URL("../../infrastructure/aliyun/docker-compose.yml", import.meta.url), "utf8");
const environmentGuide = await readFile(new URL("../../infrastructure/aliyun/ENVIRONMENT.md", import.meta.url), "utf8");

function templateEntries(source) {
  return new Map(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

const composePath = fileURLToPath(new URL("../../infrastructure/aliyun/docker-compose.yml", import.meta.url));
const composeResult = spawnSync("docker", [
  "compose",
  "--profile", "migration",
  "-f", composePath,
  "config",
  "--no-env-resolution",
  "--format", "json",
], { encoding: "utf8", windowsHide: true });
if (composeResult.error) throw composeResult.error;
if (composeResult.status !== 0) {
  if (composeResult.stderr) process.stderr.write(composeResult.stderr);
  process.exit(composeResult.status ?? 1);
}
const composeConfig = JSON.parse(composeResult.stdout);
const serviceConsumers = { app: "web", api: "api", worker: "worker", migrator: "migrator" };
const explicitInjections = new Map();
for (const [service, consumer] of Object.entries(serviceConsumers)) {
  const definition = composeConfig.services?.[service];
  if (!definition) throw new Error(`Compose config is missing service ${service}`);
  explicitInjections.set(consumer, new Set(Object.keys(definition.environment ?? {})));
}

const composeEntries = new Map([
  ...[...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)]
    .map((match) => [match[1], "<compose-interpolation>"]),
  ...[...explicitInjections.values()]
    .flatMap((entries) => [...entries].map((name) => [name, "<compose-environment>"])),
]);
const sources = {
  ".env.example": templateEntries(localTemplate),
  "infrastructure/aliyun/.env.production.template": templateEntries(productionTemplate),
  "infrastructure/aliyun/docker-compose.yml": composeEntries,
};
const actualNames = new Set(Object.values(sources).flatMap((entries) => [...entries.keys()]));
const errors = [];

for (const [source, entries] of Object.entries(sources)) {
  for (const name of entries.keys()) {
    if (!ENVIRONMENT_CONTRACT[name]) errors.push(`${source}: ${name} has no owner/consumer contract`);
  }
}
for (const name of Object.keys(ENVIRONMENT_CONTRACT)) {
  if (!actualNames.has(name)) errors.push(`${name} is declared but absent from templates and Compose`);
}
for (const [name, contract] of Object.entries(ENVIRONMENT_CONTRACT)) {
  if (!contract.owner || !contract.consumers.length) errors.push(`${name} has an incomplete responsibility contract`);
  if (contract.requiredProduction && !sources["infrastructure/aliyun/.env.production.template"].has(name)) {
    errors.push(`${name} is production-required but absent from the production template`);
  }
}

for (const [consumer, names] of explicitInjections) {
  for (const name of names) {
    const contract = ENVIRONMENT_CONTRACT[name];
    if (!contract) {
      errors.push(`Compose injects undeclared ${name} into ${consumer}`);
    } else if (!contract.consumers.includes(consumer)) {
      errors.push(`Compose injects ${name} into ${consumer}, outside declared consumers ${contract.consumers.join(", ")}`);
    }
  }
}
for (const [name, contract] of Object.entries(ENVIRONMENT_CONTRACT)) {
  for (const consumer of contract.consumers) {
    if (consumer === "compose") continue;
    if (!explicitInjections.get(consumer)?.has(name)) {
      errors.push(`${name} declares ${consumer} but Compose does not inject it`);
    }
  }
}

if ((composeConfig.services.app.env_file ?? []).length) {
  errors.push("Web app must use an explicit environment allowlist, not env_file");
}
if ((composeConfig.services.migrator.env_file ?? []).length) {
  errors.push("Migrator must use an explicit migration-only environment allowlist, not env_file");
}
const expectedMigrator = ["DATABASE_URL", "DB_SSL", "DB_SSL_REJECT_UNAUTHORIZED"];
const actualMigrator = [...explicitInjections.get("migrator") ?? []].sort();
if (JSON.stringify(actualMigrator) !== JSON.stringify(expectedMigrator)) {
  errors.push(`Migrator environment must be exactly: ${expectedMigrator.join(", ")}`);
}
const preflightStart = compose.indexOf("\n  preflight:");
const preflightEnd = compose.indexOf("\n  migrator:", preflightStart);
const preflightBlock = preflightStart >= 0 && preflightEnd > preflightStart
  ? compose.slice(preflightStart, preflightEnd)
  : "";
const preflightEnvFileSection = /^    env_file:\r?\n((?:      - .*(?:\r?\n|$))+)/mu.exec(preflightBlock);
const preflightEnvFiles = preflightEnvFileSection?.[1]
  .split(/\r?\n/u)
  .map((line) => line.replace(/^      - /u, "").trim())
  .filter(Boolean) ?? [];
if (preflightEnvFiles.length !== 1 || preflightEnvFiles[0] !== ".env.production") {
  errors.push("Production preflight must receive the single production env file outside the migrator boundary");
}
if (!environmentGuide.includes("PRODUCTION_PREFLIGHT_ENV_BOUNDARY")) {
  errors.push("Environment guide must document the production preflight env boundary");
}

const placeholder = /replace|example|configure|changeme|请填写|请生成|占位/iu;
for (const [source, entries] of Object.entries(sources)) {
  if (source.endsWith("docker-compose.yml")) continue;
  for (const [name, value] of entries) {
    if (ENVIRONMENT_CONTRACT[name]?.kind !== "secret" || !value) continue;
    if (!placeholder.test(value)) errors.push(`${source}: secret ${name} must be empty or an obvious placeholder`);
  }
}

if (errors.length) {
  console.error("Environment contract check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Environment contract covers ${actualNames.size} declared variables and verifies explicit Web/API/Worker Compose injection.`);
console.log("Production preflight is separated from the migration-only DATABASE_URL/DB_SSL allowlist.");
