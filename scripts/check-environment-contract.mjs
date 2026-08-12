import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ENVIRONMENT_CONTRACT } from "./environment-contract.mjs";

const localTemplate = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const productionTemplate = await readFile(new URL("../deploy/aliyun/.env.production.template", import.meta.url), "utf8");
const compose = await readFile(new URL("../deploy/aliyun/docker-compose.yml", import.meta.url), "utf8");
const environmentGuide = await readFile(new URL("../deploy/aliyun/ENVIRONMENT.md", import.meta.url), "utf8");

function templateEntries(source) {
  return new Map(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

const composePath = fileURLToPath(new URL("../deploy/aliyun/docker-compose.yml", import.meta.url));
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
  "deploy/aliyun/.env.production.template": templateEntries(productionTemplate),
  "deploy/aliyun/docker-compose.yml": composeEntries,
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
  if (contract.requiredProduction && !sources["deploy/aliyun/.env.production.template"].has(name)) {
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
    const viaMigratorEnvFile = consumer === "migrator"
      && sources["deploy/aliyun/.env.production.template"].has(name);
    if (!explicitInjections.get(consumer)?.has(name) && !viaMigratorEnvFile) {
      errors.push(`${name} declares ${consumer} but Compose does not inject it`);
    }
  }
}

if ((composeConfig.services.app.env_file ?? []).length) {
  errors.push("Web app must use an explicit environment allowlist, not env_file");
}
const migratorEnvFiles = composeConfig.services.migrator.env_file ?? [];
if (migratorEnvFiles.length !== 1 || !String(migratorEnvFiles[0].path ?? migratorEnvFiles[0]).endsWith(".env.production")) {
  errors.push("Migrator's acknowledged production preflight env_file boundary changed");
}
if (!environmentGuide.includes("MIGRATOR_ENV_FILE_OVERINJECTION_DEBT")) {
  errors.push("Environment guide must acknowledge the migrator env_file over-injection debt");
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
console.log("Acknowledged env_file over-injection debt: short-lived migrator production preflight (MIGRATOR_ENV_FILE_OVERINJECTION_DEBT).");
