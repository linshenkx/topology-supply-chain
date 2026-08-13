import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { assertFrozenMysqlMigrationRepository } from "../../database/tooling/mysql-migration-manifest.mjs";

const root = resolve(import.meta.dirname, "../..");
const migrationRoot = resolve(root, "database/migrations");
const mysqlMigrations = resolve(migrationRoot, "mysql");
const mysqlSchema = resolve(root, "database/runtime/schema.mysql.generated.ts").replaceAll("\\", "/");
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error("npm_execpath is required to run the pinned drizzle-kit command.");

async function hashes(directory) {
  const result = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        result[relative(directory, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  }
  await visit(directory);
  return result;
}

const repositoryBefore = await hashes(migrationRoot);
await assertFrozenMysqlMigrationRepository();
const temporaryRoot = await mkdtemp(join(tmpdir(), "stage9-drizzle-generate-"));

try {
  const temporaryMigrations = join(temporaryRoot, "mysql");
  await cp(mysqlMigrations, temporaryMigrations, { recursive: true, preserveTimestamps: true });
  const temporaryBefore = await hashes(temporaryMigrations);
  const configPath = join(temporaryRoot, "drizzle.config.mjs");
  await writeFile(
    configPath,
    `export default {\n  schema: ${JSON.stringify(mysqlSchema)},\n  out: ${JSON.stringify(temporaryMigrations.replaceAll("\\", "/"))},\n  dialect: "mysql",\n  dbCredentials: { url: "mysql://placeholder:placeholder@127.0.0.1:3306/topology_scm" },\n  strict: true,\n  verbose: true,\n};\n`,
    "utf8",
  );
  const generated = spawnSync(
    process.execPath,
    [pnpmEntry, "exec", "drizzle-kit", "generate", "--config", configPath],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (generated.error) throw generated.error;
  if (generated.status !== 0) {
    throw new Error(`Isolated drizzle-kit generate failed (${generated.status}).\n${generated.stdout}\n${generated.stderr}`);
  }
  const temporaryAfter = await hashes(temporaryMigrations);
  if (JSON.stringify(temporaryAfter) !== JSON.stringify(temporaryBefore)) {
    throw new Error("Isolated drizzle-kit generate changed the frozen migration copy.");
  }
  const repositoryAfter = await hashes(migrationRoot);
  if (JSON.stringify(repositoryAfter) !== JSON.stringify(repositoryBefore)) {
    throw new Error("Drizzle verification changed repository migration, journal, or snapshot bytes.");
  }
  await assertFrozenMysqlMigrationRepository();
  console.log("Isolated drizzle-kit generate reports no schema changes.");
  console.log(`Repository migration closure unchanged: ${Object.keys(repositoryAfter).length} files.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
