import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
const connection = await mysql.createConnection(url);

async function count(sql, parameters = []) {
  try {
    const [rows] = await connection.query(sql, parameters);
    return Number(rows[0]?.count ?? 0);
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") return 0;
    throw error;
  }
}

try {
  const enabledGenerationTwo = await count(
    "SELECT COUNT(*) AS count FROM writer_fences WHERE generation = 2 AND enabled = 1",
  );
  if (enabledGenerationTwo !== 0) {
    throw new Error("Generation 2 writers are still enabled; refusing legacy rollback.");
  }
  const v1Facts = await count(
    `SELECT COUNT(*) AS count FROM command_idempotency
      WHERE command_name IN ('auth.login','auth.verify','auth.logout','step-up.request','step-up.verify',
        'users.assign-role','users.revoke-role','users.unlock','files.upload','notifications.mark-read')`,
  );
  if (v1Facts === 0) {
    console.log("Legacy rollback is safe before the first generation 2 write fact.");
  } else {
    if (process.env.LEGACY_ROLLBACK_RECONCILED_GENERATION !== "2") {
      throw new Error("Generation 2 write facts exist; forward-fix is required unless maintenance reconciliation is explicitly approved.");
    }
    const inFlightCommands = await count(
      "SELECT COUNT(*) AS count FROM command_idempotency WHERE status IN ('pending','unknown')",
    );
    const inFlightOutbox = await count(
      "SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'processing'",
    );
    if (inFlightCommands !== 0 || inFlightOutbox !== 0) {
      throw new Error("Maintenance rollback reconciliation is incomplete; in-flight writes remain.");
    }
    console.log("Legacy rollback maintenance override accepted after generation 2 reconciliation.");
  }
} finally {
  await connection.end();
}
