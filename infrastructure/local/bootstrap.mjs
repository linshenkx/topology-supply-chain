import mysql from "mysql2/promise";

import { seedScopeAFixture } from "../../tooling/e2e/fixtures.mjs";
import { RELEASE_MANIFEST } from "../../tooling/release/release-manifest.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
const runId = process.env.LOCAL_FIXTURE_RUN_ID?.trim() || "local";
const password = process.env.LOCAL_FIXTURE_PASSWORD ?? "LocalTest!2026";

if (!databaseUrl?.startsWith("mysql://")) throw new Error("DATABASE_URL must use mysql://");
if (!/^[a-z0-9-]{1,32}$/u.test(runId)) throw new Error("LOCAL_FIXTURE_RUN_ID must contain only lowercase letters, digits, or hyphens");
if (password.length < 12) throw new Error("LOCAL_FIXTURE_PASSWORD must contain at least 12 characters");

const connection = await mysql.createConnection(databaseUrl);
let committed = false;
try {
  await connection.beginTransaction();
  const email = `admin.${runId}@e2e.invalid`;
  const [existing] = await connection.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  let fixtureStatus = "existing";
  if (existing.length === 0) {
    await seedScopeAFixture(connection, { runId, password });
    fixtureStatus = "created";
  }

  const expected = new Map(RELEASE_MANIFEST.writer.resources.map((item) => [item.resource, item]));
  const resources = [...expected.keys()];
  const placeholders = resources.map(() => "?").join(",");
  const [rows] = await connection.query(
    `SELECT resource, owner, generation FROM writer_fences WHERE resource IN (${placeholders}) FOR UPDATE`,
    resources,
  );
  const actual = new Map(rows.map((row) => [row.resource, row]));
  for (const resource of resources) {
    const row = actual.get(resource);
    const identity = expected.get(resource);
    if (row?.owner !== identity.owner || Number(row?.generation) !== identity.generation) {
      throw new Error(`Local writer fence identity mismatch for ${resource}`);
    }
  }
  await connection.query(
    `UPDATE writer_fences SET enabled = 1, updated_at = CURRENT_TIMESTAMP(3) WHERE resource IN (${placeholders})`,
    resources,
  );
  await connection.commit();
  committed = true;
  process.stdout.write(`${JSON.stringify({ status: "ready", fixtureStatus, runId, adminEmail: email, activatedResources: resources.length })}\n`);
} catch (error) {
  if (!committed) await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
