import mysql from "mysql2/promise";

import {
  assertFrozenMysqlMigrationRepository,
  FROZEN_MYSQL_MIGRATIONS,
} from "./mysql-migration-manifest.mjs";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
await assertFrozenMysqlMigrationRepository();

const connection = await mysql.createConnection(url);
async function assertFreshSchema() {
  const [objects] = await connection.query(
    `SELECT 'table_or_view' AS kind, table_name AS name
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations'
     UNION ALL
     SELECT 'trigger' AS kind, trigger_name AS name
       FROM information_schema.triggers WHERE trigger_schema = DATABASE()
     UNION ALL
     SELECT 'routine' AS kind, routine_name AS name
       FROM information_schema.routines WHERE routine_schema = DATABASE()
     UNION ALL
     SELECT 'event' AS kind, event_name AS name
       FROM information_schema.events WHERE event_schema = DATABASE()`,
  );
  if (objects.length !== 0) {
    throw new Error(`Migration history is empty but schema contains ${objects[0].kind} ${objects[0].name}; refusing fresh baseline.`);
  }
  console.log("Migration history and business schema are empty; fresh baseline is allowed.");
}

try {
  let rows;
  try {
    [rows] = await connection.query("SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at ASC, id ASC");
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") rows = [];
    else throw error;
  }

  if (rows.length === 0) await assertFreshSchema();
  if (rows.length > FROZEN_MYSQL_MIGRATIONS.length) {
    throw new Error(`Database has ${rows.length} migration entries but the frozen manifest has ${FROZEN_MYSQL_MIGRATIONS.length}; refusing unknown future history.`);
  }
  for (const [index, row] of rows.entries()) {
    const expected = FROZEN_MYSQL_MIGRATIONS[index];
    if (Number(row.id) !== index + 1 || row.hash !== expected.hash || Number(row.createdAt) !== expected.createdAt) {
      throw new Error(`Migration history mismatch at entry ${index} (${expected.name}). Observed id=${row.id}, hash=${row.hash}, created_at=${row.createdAt}; expected id=${index + 1}, hash=${expected.hash}, created_at=${expected.createdAt}. Stop for forensic reconciliation; never rewrite __drizzle_migrations.`);
    }
  }
  console.log(`Migration history preflight passed (${rows.length}/${FROZEN_MYSQL_MIGRATIONS.length} canonical entries applied).`);
} finally {
  await connection.end();
}
