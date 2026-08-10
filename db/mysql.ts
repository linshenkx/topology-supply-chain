import mysql, { type Pool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "./schema.mysql.generated";
import { toMysqlDateTime } from "../app/lib/business-rules";

declare global {
  // Reuse the pool during development hot reloads and across route invocations.
  // eslint-disable-next-line no-var
  var topologyMysqlPool: Pool | undefined;
}

function normalizeParams(values: unknown) {
  if (!Array.isArray(values)) return values;
  return values.map((value) =>
    typeof value === "string" ? toMysqlDateTime(value) : value,
  );
}

function installDateParameterAdapter(pool: Pool) {
  const mutable = pool as unknown as {
    query: (...args: unknown[]) => unknown;
    execute: (...args: unknown[]) => unknown;
  };
  const originalQuery = mutable.query.bind(pool);
  const originalExecute = mutable.execute.bind(pool);
  mutable.query = (...args: unknown[]) => {
    if (args.length > 1) args[1] = normalizeParams(args[1]);
    return originalQuery(...args);
  };
  mutable.execute = (...args: unknown[]) => {
    if (args.length > 1) args[1] = normalizeParams(args[1]);
    return originalExecute(...args);
  };
}

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value || !value.startsWith("mysql://")) {
    throw new Error("生产环境缺少有效的RDS MySQL DATABASE_URL。");
  }
  return value;
}

export function getMysqlPool() {
  if (!globalThis.topologyMysqlPool) {
    const pool = mysql.createPool({
      uri: requireDatabaseUrl(),
      connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      timezone: "+08:00",
      decimalNumbers: true,
      dateStrings: true,
      ssl: process.env.DB_SSL === "disabled"
        ? undefined
        : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" },
    });
    installDateParameterAdapter(pool);
    globalThis.topologyMysqlPool = pool;
  }
  return globalThis.topologyMysqlPool;
}

export function getMysqlDb() {
  return drizzle({ client: getMysqlPool(), schema, mode: "default" });
}

export async function checkMysqlConnection() {
  const [rows] = await getMysqlPool().query<mysql.RowDataPacket[]>(
    "SELECT 1 AS healthy, CURRENT_TIMESTAMP AS server_time",
  );
  return rows[0];
}

export async function closeMysqlPool() {
  if (globalThis.topologyMysqlPool) {
    await globalThis.topologyMysqlPool.end();
    globalThis.topologyMysqlPool = undefined;
  }
}
