import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  for (const [table, predicate] of [
    ["outbox_messages", "status = 'processing'"],
    ["command_idempotency", "status IN ('pending', 'unknown')"],
  ]) {
    try {
      const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`);
      if (Number(rows[0]?.count) !== 0) throw new Error(`${table} has unreconciled writes; reconcile before migration`);
    } catch (error) {
      if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
    }
  }
  console.log("Writer drain/reconciliation preflight passed.");
} finally { await connection.end(); }
