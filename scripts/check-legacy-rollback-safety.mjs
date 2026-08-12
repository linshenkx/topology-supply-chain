import mysql from "mysql2/promise";

import { parseReleaseManifest } from "./release-manifest.mjs";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
const target = parseReleaseManifest(process.env.TARGET_RELEASE_MANIFEST_JSON ?? "", "rollback target manifest");
const connection = await mysql.createConnection(url);

try {
  const [history] = await connection.query(
    "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, id",
  );
  if (history.length !== target.schema.migrations.length) {
    throw new Error("Database schema history does not exactly match the rollback manifest; forward-fix is required.");
  }
  for (const [index, actual] of history.entries()) {
    const expected = target.schema.migrations[index];
    if (actual.hash !== expected.hash || Number(actual.createdAt) !== expected.createdAt) {
      throw new Error(`Database schema history differs from rollback manifest at ${expected.name}; forward-fix is required.`);
    }
  }

  const commandIdentities = new Set(target.writer.commands.map(({ command }) => command));
  const [facts] = await connection.query("SELECT DISTINCT command_name AS commandName FROM command_idempotency");
  const unknownFacts = facts.map(({ commandName }) => commandName).filter((command) => !commandIdentities.has(command));
  if (unknownFacts.length !== 0) {
    throw new Error(`Rollback target does not recognize generation-2 write facts: ${unknownFacts.join(", ")}; forward-fix is required.`);
  }

  const resources = new Map(target.writer.resources.map((resource) => [resource.resource, resource]));
  const [enabledFences] = await connection.query(
    "SELECT resource, owner, generation FROM writer_fences WHERE enabled = 1 AND generation >= 2",
  );
  for (const fence of enabledFences) {
    const expected = resources.get(fence.resource);
    if (expected?.owner !== fence.owner || expected?.generation !== Number(fence.generation)) {
      throw new Error(`Rollback target is incompatible with active writer ${fence.resource}; forward-fix is required.`);
    }
  }

  console.log(`Rollback database safety passed for ${facts.length} canonical command fact type(s) and ${enabledFences.length} active generation-2 fence(s).`);
} finally {
  await connection.end();
}
