import { readFile } from "node:fs/promises";

import { ENVIRONMENT_CONTRACT } from "./environment-contract.mjs";

const localTemplate = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const productionTemplate = await readFile(new URL("../deploy/aliyun/.env.production.template", import.meta.url), "utf8");
const compose = await readFile(new URL("../deploy/aliyun/docker-compose.yml", import.meta.url), "utf8");

function templateEntries(source) {
  return new Map(source.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

const sources = {
  ".env.example": templateEntries(localTemplate),
  "deploy/aliyun/.env.production.template": templateEntries(productionTemplate),
  "deploy/aliyun/docker-compose.yml": new Map(
    [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => [match[1], "<compose>"]),
  ),
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
console.log(`Environment contract covers ${actualNames.size} variables with explicit owners and consumers.`);
