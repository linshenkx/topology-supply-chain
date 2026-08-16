import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { ENVIRONMENT_CONTRACT } from "./environment-contract.mjs";

const templateUrl = new URL("../../infrastructure/aliyun/.env.production.template", import.meta.url);
const composeUrl = new URL("../../infrastructure/aliyun/docker-compose.yml", import.meta.url);
const template = await readFile(templateUrl, "utf8");
const compose = await readFile(composeUrl, "utf8");

function templateEntries(source) {
  return new Map(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

const templateValues = templateEntries(template);
const result = spawnSync("docker", [
  "compose",
  "--env-file", fileURLToPath(templateUrl),
  "--profile", "tools",
  "-f", fileURLToPath(composeUrl),
  "config", "--format", "json",
], { encoding: "utf8", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const normalized = JSON.parse(result.stdout);
const serviceConsumers = {
  app: "web",
  backend: "backend",
  migrator: "migrator",
  bootstrap: "bootstrap",
  stub: "stub",
};
const explicit = new Map();
for (const [service, consumer] of Object.entries(serviceConsumers)) {
  const definition = normalized.services?.[service];
  if (!definition) throw new Error(`Compose config is missing service ${service}`);
  explicit.set(consumer, new Set(Object.keys(definition.environment ?? {})));
}

const names = new Set([
  ...templateValues.keys(),
  ...[...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]),
  ...[...explicit.values()].flatMap((values) => [...values]),
]);
const errors = [];

for (const name of names) {
  if (!ENVIRONMENT_CONTRACT[name]) errors.push(`${name} has no environment responsibility contract`);
}
for (const [name, contract] of Object.entries(ENVIRONMENT_CONTRACT)) {
  if (!names.has(name)) errors.push(`${name} is declared but absent from template and Compose`);
  if (contract.requiredProduction && !templateValues.has(name)) {
    errors.push(`${name} is UAT-required but absent from the private env template`);
  }
  for (const consumer of contract.consumers) {
    if (consumer === "compose") continue;
    if (!explicit.get(consumer)?.has(name)) {
      errors.push(`${name} declares ${consumer} but Compose does not inject it`);
    }
  }
}
for (const [consumer, values] of explicit) {
  for (const name of values) {
    const contract = ENVIRONMENT_CONTRACT[name];
    if (contract && !contract.consumers.includes(consumer)) {
      errors.push(`Compose injects ${name} into ${consumer}, outside ${contract.consumers.join(", ")}`);
    }
  }
}

const placeholder = /<|replace|example|configure|changeme|请填写|请生成|占位/iu;
for (const [name, value] of templateValues) {
  if (ENVIRONMENT_CONTRACT[name]?.kind === "secret" && value && !placeholder.test(value)) {
    errors.push(`Template secret ${name} must be empty or an obvious placeholder`);
  }
}
for (const service of Object.keys(serviceConsumers)) {
  if ((normalized.services[service].env_file ?? []).length > 0) {
    errors.push(`${service} must use an explicit environment allowlist`);
  }
}
const migrator = [...explicit.get("migrator") ?? []].sort();
if (JSON.stringify(migrator) !== JSON.stringify(["DATABASE_URL", "DB_SSL", "DB_SSL_REJECT_UNAUTHORIZED"])) {
  errors.push("Migrator may receive only DATABASE_URL, DB_SSL and DB_SSL_REJECT_UNAUTHORIZED");
}

if (errors.length > 0) {
  console.error("Environment contract check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`UAT environment contract covers ${names.size} variables across Web, Backend and one-shot tools.`);
