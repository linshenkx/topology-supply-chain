import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RELEASE_MANIFEST,
  assertReleaseManifest,
  parseReleaseManifest,
  releaseManifestJson,
} from "../scripts/release-manifest.mjs";
import { checkReleaseCompatibility } from "../scripts/check-release-compatibility.mjs";

const root = new URL("..", import.meta.url);
const deploy = readFileSync(new URL("../deploy/aliyun/deploy.sh", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../deploy/aliyun/rollback.sh", import.meta.url), "utf8");
const activation = readFileSync(new URL("../scripts/activate-writers.sh", import.meta.url), "utf8");
const rollbackSafety = readFileSync(new URL("../scripts/check-legacy-rollback-safety.mjs", import.meta.url), "utf8");
const platformCommands = readFileSync(new URL("../apps/api/src/platform/commands.ts", import.meta.url), "utf8");
const r2Contracts = readFileSync(new URL("../packages/contracts/src/r2-writes.ts", import.meta.url), "utf8");
const r3Contracts = readFileSync(new URL("../packages/contracts/src/r3-fulfillment-writes.ts", import.meta.url), "utf8");
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
  return spawnSync(process.execPath, ["scripts/check-release-compatibility.mjs"], {
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
  assert.equal(RELEASE_MANIFEST.schema.migrations.length, 5);
  assert.equal(RELEASE_MANIFEST.writer.generation, 2);
  assert.equal(RELEASE_MANIFEST.writer.legacyWriterCompatible, false);
  assert.equal(RELEASE_MANIFEST.writer.commands.length, 35);
  assert.equal(RELEASE_MANIFEST.writer.resources.length, 29);
  assert.deepEqual(RELEASE_MANIFEST.runtimeServices, ["app", "api", "worker"]);
  assert.equal(new Set(RELEASE_MANIFEST.writer.commands.map(({ command }) => command)).size, 35);
  assert.equal(new Set(RELEASE_MANIFEST.writer.resources.map(({ resource }) => resource)).size, 29);
});

test("release manifest identities match the frozen platform, R2, R3, and Worker runtime sources", () => {
  const platform = quotedPairs(platformCommands, "COMMAND_WRITER_RESOURCES", "});");
  const r2Section = r2Contracts.slice(r2Contracts.indexOf("R2_COMMANDS = ["), r2Contracts.indexOf("] as const"));
  const r2 = [...r2Section.matchAll(/^\s*"([^"]+)",?$/gmu)].map(([, command]) => ({
    command,
    generation: 2,
    owner: "fastify-v1",
    resource: `r2.${command}`,
  }));
  const r3 = quotedPairs(r3Contracts, "R3_COMMAND_RESOURCES", "});");
  const expectedCommands = [...platform, ...r2, ...r3].sort((left, right) => left.command.localeCompare(right.command));
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
  assert.match(deploy, /docker compose build app api worker migrator/u);
  assert.match(deploy, /node scripts\/release-manifest\.mjs print/u);
  assert.match(deploy, /node scripts\/check-mysql-migration-history\.mjs/u);
  assert.match(deploy, /node scripts\/check-write-drain\.mjs/u);
  assert.match(deploy, /docker compose --profile migration run --rm migrator\s*$/mu);
  assert.match(deploy, /docker compose up -d app api worker/u);
});

test("writer activation is independent, explicit, and defaults to an empty fail-closed allowlist", () => {
  assert.match(activation, /if \[\[ \$# -lt 2 \]\]/u);
  assert.match(activation, /WRITER_ACTIVATION_RESOURCES/u);
  assert.match(activation, /WRITER_ACTIVATION_EVIDENCE_SHA256/u);
  assert.match(activation, /set-writer-fences\.mjs \/tmp\/writer-activation-evidence\.json/u);
  assert.doesNotMatch(deploy, /WRITER_ACTIVATION_RESOURCES/u);
});

test("rollback requires manifests and never guesses compatibility or accepts a legacy override", () => {
  assert.match(rollback, /\.active-release-manifest\.json/u);
  assert.match(rollback, /check-release-compatibility\.mjs/u);
  assert.match(rollback, /check-legacy-rollback-safety\.mjs/u);
  assert.match(rollback, /topology-scm-worker:\$\{WORKER_IMAGE_TAG\}/u);
  assert.doesNotMatch(rollback, /if docker image inspect "topology-scm-worker/u);
  assert.doesNotMatch(rollback, /LEGACY_ROLLBACK_RECONCILED_GENERATION|override/u);
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
  const result = spawnSync(process.execPath, ["scripts/check-release-compatibility.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CURRENT_RELEASE_MANIFEST_JSON: await releaseManifestJson(), TARGET_RELEASE_MANIFEST_JSON: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/u);
});
