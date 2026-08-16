import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RELEASE_MANIFEST,
  assertReleaseManifest,
  parseReleaseManifest,
  releaseManifestJson,
} from "../tooling/release/release-manifest.mjs";
import { checkReleaseCompatibility } from "../tooling/release/check-release-compatibility.mjs";

const root = new URL("..", import.meta.url);
const deploy = readFileSync(new URL("../infrastructure/aliyun/deploy.sh", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../infrastructure/aliyun/rollback.sh", import.meta.url), "utf8");
const activation = readFileSync(new URL("../tooling/release/activate-writers.sh", import.meta.url), "utf8");
const rollbackSafety = readFileSync(new URL("../tooling/release/check-legacy-rollback-safety.mjs", import.meta.url), "utf8");
const platformCommands = readFileSync(new URL("../apps/api/src/platform/commands.ts", import.meta.url), "utf8");
const supplyContracts = readFileSync(new URL("../packages/contracts/src/supply-writes.ts", import.meta.url), "utf8");
const operationsContracts = readFileSync(new URL("../packages/contracts/src/operations-writes.ts", import.meta.url), "utf8");
const workerServer = readFileSync(new URL("../apps/worker/src/server.ts", import.meta.url), "utf8");

async function cloneManifest() {
  return JSON.parse(await releaseManifestJson());
}

function deleteResourceForCommand(value, commandName) {
  const command = value.writer.commands.find(({ command }) => command === commandName);
  value.writer.commands = value.writer.commands.filter(({ command }) => command !== commandName);
  if (!value.writer.commands.some(({ resource }) => resource === command.resource)) {
    value.writer.resources = value.writer.resources.filter(({ resource }) => resource !== command.resource);
  }
}

function runCompatibility(current, target) {
  return spawnSync(process.execPath, ["tooling/release/check-release-compatibility.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CURRENT_RELEASE_MANIFEST_JSON: JSON.stringify(current),
      TARGET_RELEASE_MANIFEST_JSON: JSON.stringify(target),
    },
  });
}

function quotedPairs(source, start, end) {
  const section = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return [...section.matchAll(/^\s*"([^"]+)": "([^"]+)",?$/gmu)]
    .map(([, command, resource]) => ({ command, generation: 2, owner: "fastify-v1", resource }));
}

test("release manifest is complete, canonical, and deterministic", async () => {
  assert.equal(assertReleaseManifest(RELEASE_MANIFEST), RELEASE_MANIFEST);
  assert.deepEqual(parseReleaseManifest(await releaseManifestJson()), RELEASE_MANIFEST);
  assert.equal(RELEASE_MANIFEST.manifestVersion, 1);
  assert.equal(RELEASE_MANIFEST.schema.migrations.length, 6);
  assert.equal(RELEASE_MANIFEST.writer.generation, 2);
  assert.equal(RELEASE_MANIFEST.writer.legacyWriterCompatible, false);
  assert.equal(RELEASE_MANIFEST.writer.commands.length, 36);
  assert.equal(RELEASE_MANIFEST.writer.resources.length, 30);
  assert.deepEqual(RELEASE_MANIFEST.runtimeServices, ["app", "backend"]);
  assert.equal(new Set(RELEASE_MANIFEST.writer.commands.map(({ command }) => command)).size, 36);
  assert.equal(new Set(RELEASE_MANIFEST.writer.resources.map(({ resource }) => resource)).size, 30);
});

test("release manifest identities match the frozen platform, supply, operations, and Worker runtime sources", () => {
  const platform = quotedPairs(platformCommands, "COMMAND_WRITER_RESOURCES", "});");
  const supplySection = supplyContracts.slice(supplyContracts.indexOf("SUPPLY_COMMANDS = ["), supplyContracts.indexOf("] as const"));
  const supplyCommands = [...supplySection.matchAll(/^\s*"([^"]+)",?$/gmu)].map(([, command]) => ({
    command,
    generation: 2,
    owner: "fastify-v1",
    resource: `r2.${command}`,
  }));
  const operationsResources = quotedPairs(operationsContracts, "OPERATIONS_COMMAND_RESOURCES", "});");
  const expectedCommands = [...platform, ...supplyCommands, ...operationsResources].sort((left, right) => left.command.localeCompare(right.command));
  const actualCommands = [...RELEASE_MANIFEST.writer.commands].sort((left, right) => left.command.localeCompare(right.command));
  assert.deepEqual(actualCommands, expectedCommands);

  const workerStart = workerServer.indexOf("const workerFenceResources = [");
  const workerSection = workerServer.slice(workerStart, workerServer.indexOf("] as const", workerStart));
  const workerResources = [...workerSection.matchAll(/"([^"]+\.worker)"/gu)].map(([, resource]) => ({
    generation: 2,
    owner: "worker-v1",
    resource,
  }));
  const commandResources = [...new Map(expectedCommands.map(({ generation, owner, resource }) => [resource, { generation, owner, resource }])).values()];
  const expectedResources = [...commandResources, ...workerResources].sort((left, right) => left.resource.localeCompare(right.resource));
  assert.deepEqual(RELEASE_MANIFEST.writer.resources, expectedResources);
});

test("ordinary deploy has zero writer activation path", () => {
  assert.doesNotMatch(deploy, /set-writer-fences|activate-writers|WRITER_ACTIVATION/u);
  assert.match(deploy, /docker compose --env-file \.env\.production --profile tools run --rm migrator/u);
  assert.match(deploy, /docker compose --env-file \.env\.production --profile tools run --rm bootstrap/u);
  assert.match(deploy, /docker compose --env-file \.env\.production up -d --remove-orphans stub backend app nginx/u);
  assert.doesNotMatch(deploy, /docker compose build|docker image prune/u);
});

test("writer activation is independent, explicit, and defaults to an empty fail-closed allowlist", () => {
  assert.match(activation, /if \[\[ \$# -lt 2 \]\]/u);
  assert.match(activation, /WRITER_ACTIVATION_RESOURCES/u);
  assert.match(activation, /WRITER_ACTIVATION_EVIDENCE_SHA256/u);
  assert.match(activation, /set-writer-fences\.mjs \/tmp\/writer-activation-evidence\.json/u);
  assert.doesNotMatch(deploy, /WRITER_ACTIVATION_RESOURCES/u);
});

test("UAT rollback switches only known Web and Backend images without touching schema", () => {
  assert.match(rollback, /export WEB_IMAGE="\$1"/u);
  assert.match(rollback, /export BACKEND_IMAGE="\$2"/u);
  assert.match(rollback, /up -d --no-build stub backend app nginx/u);
  assert.doesNotMatch(rollback, /db:migrate|drizzle|\.sql|LEGACY_ROLLBACK_RECONCILED_GENERATION|override/iu);
  assert.doesNotMatch(rollbackSafety, /command_name IN\s*\(/u);
  assert.doesNotMatch(rollbackSafety, /LEGACY_ROLLBACK_RECONCILED_GENERATION|override/u);
  assert.match(rollbackSafety, /SELECT DISTINCT command_name AS commandName FROM command_idempotency/u);
});

test("same-generation compatible release passes", async () => {
  const current = await cloneManifest();
  const target = await cloneManifest();
  assert.doesNotThrow(() => checkReleaseCompatibility(current, target));
  const result = runCompatibility(current, target);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate, pattern] of [
  ["pre-Scope-A", (value) => {
    value.compatibility.releaseSequence = 1;
    deleteResourceForCommand(value, "approvals.decide");
    deleteResourceForCommand(value, "imports.preview");
  }, /canonical command identities/u],
  ["schema", (value) => { value.schema.contract = "mysql.scope-a.0000-0003"; }, /schema contract/u],
  ["generation", (value) => { value.writer.generation = 1; }, /writer generation/u],
  ["command", (value) => { value.writer.commands[0].command = "auth.legacy"; }, /canonical command identities/u],
  ["resource", (value) => { value.writer.resources[0].owner = "legacy"; }, /command\/resource identity|canonical resource identities/u],
  ["minimum version", (value) => { value.compatibility.releaseSequence = 0; }, /integer >= 1|minimum compatible version/u],
]) {
  test(`${name} incompatible rollback manifest is rejected`, async () => {
    const current = await cloneManifest();
    const target = await cloneManifest();
    mutate(target);
    const result = runCompatibility(current, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  });
}

test("missing rollback manifest is rejected", async () => {
  const result = spawnSync(process.execPath, ["tooling/release/check-release-compatibility.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CURRENT_RELEASE_MANIFEST_JSON: await releaseManifestJson(), TARGET_RELEASE_MANIFEST_JSON: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/u);
});
