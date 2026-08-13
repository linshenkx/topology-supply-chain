import mysql from "mysql2/promise";

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL，请先加载生产环境配置");
}

const tableNames = [
  "supplier_performance_reviews",
  "supplier_performance_weight_versions",
];
const db = await mysql.createConnection(process.env.DATABASE_URL);

try {
  const [rows] = await db.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (?, ?)`,
    tableNames,
  );
  const existing = rows.map((row) => row.TABLE_NAME ?? row.table_name);

  if (existing.length > 0) {
    console.error("预检未通过：上次失败留下了业务表，请勿继续迁移。", existing);
    process.exitCode = 2;
  } else {
    console.log("预检通过：未发现残留业务表，可以安全重试迁移。");
  }
} finally {
  await db.end();
}
