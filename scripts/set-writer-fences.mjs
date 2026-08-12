import mysql from "mysql2/promise";
const resources = [
  "auth.commands", "users.commands", "files.commands", "notifications.commands",
  "outbox.worker", "reminders.worker", "files.worker",
  "r2.imports.preview", "r2.imports.stage", "r2.imports.commit",
  "r2.master-data.write", "r2.suppliers.write", "r2.supplier-skus.write",
  "r2.supplier-prices.write", "r2.supplier-performance.write",
  "r2.purchase-plans.create", "r2.purchase-plans.update",
  "r2.purchase-orders.create", "r2.purchase-orders.update",
  "r3.approvals.commands", "r3.inventory.commands", "r3.transfers.commands",
  "r3.production-orders.commands", "r3.quality-inspections.commands",
  "r3.stocktakes.commands", "r3.shipments.commands", "r3.returns.commands",
  "r3.finance.commands", "r3.warehouses.commands",
];
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  await connection.query(
    `UPDATE writer_fences SET enabled = 1, updated_at = CURRENT_TIMESTAMP(3)
     WHERE generation = 2 AND resource IN (${resources.map(() => "?").join(",")})`, resources);
  const [rows] = await connection.query(
    `SELECT resource, owner, enabled, generation FROM writer_fences
     WHERE resource IN (${resources.map(() => "?").join(",")})`, resources);
  const byResource = new Map(rows.map((row) => [row.resource, row]));
  for (const resource of resources) {
    const row = byResource.get(resource);
    const expectedOwner = resource.endsWith(".worker") ? "worker-v1" : "fastify-v1";
    if (row?.owner !== expectedOwner || Number(row.generation) !== 2 || Number(row.enabled) !== 1) {
      throw new Error("Writer fence generation 2 is incomplete; refusing activation");
    }
  }
  console.log("Writer fence generation 2 activated.");
} finally { await connection.end(); }
