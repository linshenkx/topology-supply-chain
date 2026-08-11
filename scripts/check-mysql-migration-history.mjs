import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
const files = (await readdir(new URL("../drizzle-mysql/", import.meta.url)))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
const local = await Promise.all(files.map(async (name) => ({
  name,
  hash: createHash("sha256").update(await readFile(new URL(`../drizzle-mysql/${name}`, import.meta.url))).digest("hex"),
})));
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
    [rows] = await connection.query("SELECT id, hash FROM __drizzle_migrations ORDER BY id ASC");
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      rows = [];
    } else {
      throw error;
    }
  }
  if (rows.length === 0) await assertFreshSchema();
  for (const [index, row] of rows.entries()) {
    if (local[index] === undefined || row.hash !== local[index].hash) {
      throw new Error(`Migration history mismatch at entry ${index}; stop and use the controlled upgrade path. Historical migrations must not be rewritten.`);
    }
  }
  console.log(`Migration history preflight passed (${rows.length} applied entries).`);
} finally { await connection.end(); }
