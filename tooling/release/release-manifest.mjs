import { pathToFileURL } from "node:url";

import {
  assertFrozenMysqlMigrationRepository,
  FROZEN_MYSQL_MIGRATIONS,
} from "../../database/tooling/mysql-migration-manifest.mjs";

const migrations = Object.freeze(FROZEN_MYSQL_MIGRATIONS.map(({
  createdAt,
  hash,
  name,
  snapshotHash,
}) => Object.freeze({ createdAt, hash, name, snapshotHash })));

const commands = Object.freeze([
  ["auth.login", "auth.commands"],
  ["auth.logout", "auth.commands"],
  ["auth.verify", "auth.commands"],
  ["step-up.request", "auth.commands"],
  ["step-up.verify", "auth.commands"],
  ["files.upload", "files.commands"],
  ["notifications.mark-read", "notifications.commands"],
  ["users.assign-role", "users.commands"],
  ["users.revoke-role", "users.commands"],
  ["users.unlock", "users.commands"],
  ["imports.preview", "r2.imports.preview"],
  ["imports.stage", "r2.imports.stage"],
  ["imports.commit", "r2.imports.commit"],
  ["master-data.write", "r2.master-data.write"],
  ["suppliers.write", "r2.suppliers.write"],
  ["supplier-skus.write", "r2.supplier-skus.write"],
  ["supplier-prices.write", "r2.supplier-prices.write"],
  ["supplier-performance.write", "r2.supplier-performance.write"],
  ["purchase-plans.create", "r2.purchase-plans.create"],
  ["purchase-plans.update", "r2.purchase-plans.update"],
  ["purchase-orders.create", "r2.purchase-orders.create"],
  ["purchase-orders.update", "r2.purchase-orders.update"],
  ["purchase.receive", "r3.purchase-receipts.commands"],
  ["approvals.decide", "r3.approvals.commands"],
  ["inventory.reserve", "r3.inventory.commands"],
  ["inventory.transfer.request", "r3.transfers.commands"],
  ["inventory.transfer.transition", "r3.transfers.commands"],
  ["manufacturing.order.create", "r3.production-orders.commands"],
  ["manufacturing.order.transition", "r3.production-orders.commands"],
  ["quality.inspection.submit", "r3.quality-inspections.commands"],
  ["inventory.stocktake.open", "r3.stocktakes.commands"],
  ["inventory.stocktake.transition", "r3.stocktakes.commands"],
  ["logistics.shipment.command", "r3.shipments.commands"],
  ["returns.command", "r3.returns.commands"],
  ["finance.command", "r3.finance.commands"],
  ["warehouses.command", "r3.warehouses.commands"],
].map(([command, resource]) => Object.freeze({
  command,
  generation: 2,
  owner: "fastify-v1",
  resource,
})));

const workerResources = Object.freeze([
  "files.worker",
  "outbox.worker",
  "reminders.worker",
].map((resource) => Object.freeze({ generation: 2, owner: "worker-v1", resource })));

const commandResources = [...new Set(commands.map(({ resource }) => resource))]
  .sort()
  .map((resource) => Object.freeze({ generation: 2, owner: "fastify-v1", resource }));

export const RELEASE_MANIFEST = Object.freeze({
  compatibility: Object.freeze({
    minimumManifestVersion: 1,
    minimumReleaseSequence: 1,
    releaseSequence: 1,
  }),
  contract: Object.freeze({
    id: "topology-scm.scope-a.schema-0005.writer-generation-2",
    releaseFamily: "topology-scm.scope-a",
  }),
  manifestVersion: 1,
  runtimeServices: Object.freeze(["app", "backend"]),
  schema: Object.freeze({
    contract: "mysql.scope-a.0000-0005",
    migrations,
  }),
  writer: Object.freeze({
    commands,
    generation: 2,
    legacyWriterCompatible: false,
    resources: Object.freeze([...commandResources, ...workerResources]
      .sort((left, right) => left.resource.localeCompare(right.resource))),
  }),
});

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requireUnique(items, key, label) {
  const values = items.map((item) => item[key]);
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate ${key} values`);
}

export function assertReleaseManifest(value, label = "release manifest") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  requireInteger(value.manifestVersion, `${label}.manifestVersion`, 1);
  requireString(value.contract?.id, `${label}.contract.id`);
  requireString(value.contract?.releaseFamily, `${label}.contract.releaseFamily`);
  requireInteger(value.compatibility?.minimumManifestVersion, `${label}.compatibility.minimumManifestVersion`, 1);
  requireInteger(value.compatibility?.minimumReleaseSequence, `${label}.compatibility.minimumReleaseSequence`, 1);
  requireInteger(value.compatibility?.releaseSequence, `${label}.compatibility.releaseSequence`, 1);
  requireString(value.schema?.contract, `${label}.schema.contract`);
  if (!Array.isArray(value.schema?.migrations) || value.schema.migrations.length === 0) {
    throw new Error(`${label}.schema.migrations must be non-empty`);
  }
  requireUnique(value.schema.migrations, "name", `${label}.schema.migrations`);
  requireUnique(value.schema.migrations, "hash", `${label}.schema.migrations`);
  for (const [index, migration] of value.schema.migrations.entries()) {
    requireString(migration?.name, `${label}.schema.migrations[${index}].name`);
    if (!/^[a-f\d]{64}$/u.test(migration?.hash ?? "")) throw new Error(`${label}.schema.migrations[${index}].hash is invalid`);
    if (!/^[a-f\d]{64}$/u.test(migration?.snapshotHash ?? "")) throw new Error(`${label}.schema.migrations[${index}].snapshotHash is invalid`);
    requireInteger(migration?.createdAt, `${label}.schema.migrations[${index}].createdAt`, 1);
  }
  requireInteger(value.writer?.generation, `${label}.writer.generation`, 1);
  if (value.writer?.legacyWriterCompatible !== false) throw new Error(`${label} must fail closed for legacy writers`);
  if (!Array.isArray(value.writer?.commands) || value.writer.commands.length === 0) throw new Error(`${label}.writer.commands must be non-empty`);
  if (!Array.isArray(value.writer?.resources) || value.writer.resources.length === 0) throw new Error(`${label}.writer.resources must be non-empty`);
  requireUnique(value.writer.commands, "command", `${label}.writer.commands`);
  requireUnique(value.writer.resources, "resource", `${label}.writer.resources`);
  const resources = new Map(value.writer.resources.map((resource) => [resource.resource, resource]));
  for (const [index, command] of value.writer.commands.entries()) {
    requireString(command?.command, `${label}.writer.commands[${index}].command`);
    requireString(command?.resource, `${label}.writer.commands[${index}].resource`);
    requireString(command?.owner, `${label}.writer.commands[${index}].owner`);
    requireInteger(command?.generation, `${label}.writer.commands[${index}].generation`, 1);
    const resource = resources.get(command.resource);
    if (resource?.owner !== command.owner || resource?.generation !== command.generation) {
      throw new Error(`${label} command/resource identity is inconsistent for ${command.command}`);
    }
  }
  for (const [index, resource] of value.writer.resources.entries()) {
    requireString(resource?.resource, `${label}.writer.resources[${index}].resource`);
    requireString(resource?.owner, `${label}.writer.resources[${index}].owner`);
    requireInteger(resource?.generation, `${label}.writer.resources[${index}].generation`, 1);
  }
  if (!Array.isArray(value.runtimeServices) || value.runtimeServices.length === 0) throw new Error(`${label}.runtimeServices must be non-empty`);
  for (const [index, service] of value.runtimeServices.entries()) requireString(service, `${label}.runtimeServices[${index}]`);
  return value;
}

export function parseReleaseManifest(json, label = "release manifest") {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return assertReleaseManifest(value, label);
}

export async function releaseManifestJson(migrationDirectory) {
  await assertFrozenMysqlMigrationRepository(migrationDirectory);
  assertReleaseManifest(RELEASE_MANIFEST);
  return `${JSON.stringify(RELEASE_MANIFEST, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2] ?? "print";
  if (operation !== "print") throw new Error("Usage: node tooling/release/release-manifest.mjs [print]");
  process.stdout.write(await releaseManifestJson());
}
