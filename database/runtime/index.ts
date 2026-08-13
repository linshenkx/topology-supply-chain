import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { isAliyunRuntime } from "@topology/shared-config/runtime-env";

type PreviewDb = ReturnType<typeof drizzle<typeof schema>>;

let previewBinding: unknown;
let productionDb: unknown;
let createProductionDb: (() => unknown) | undefined;
if (isAliyunRuntime()) {
  const { getMysqlDb } = await import("./mysql");
  // Load the adapter during the build, but create the connection pool lazily.
  // Next.js imports route modules while collecting build metadata, when
  // production secrets are intentionally unavailable.
  createProductionDb = getMysqlDb;
} else {
  const workersModuleName = "cloudflare:workers";
  const workers = await import(workersModuleName) as {
    env?: { DB?: Parameters<typeof drizzle>[0] };
  };
  previewBinding = workers.env?.DB;
}

export function getDb(): PreviewDb {
  if (isAliyunRuntime()) {
    // The business routes use the shared Drizzle table metadata. MySQL-specific
    // insert return semantics are normalized by db/insert-one.ts.
    return getProductionDb() as unknown as PreviewDb;
  }
  if (!previewBinding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(previewBinding as Parameters<typeof drizzle>[0], { schema });
}

function getProductionDb() {
  if (!productionDb && createProductionDb) {
    productionDb = createProductionDb();
  }
  if (!productionDb) {
    throw new Error("RDS适配器尚未初始化。请使用initializeProductionDb()启动Node服务。");
  }
  return productionDb;
}

export async function initializeProductionDb() {
  if (!isAliyunRuntime()) return;
  const { getMysqlDb, checkMysqlConnection } = await import("./mysql");
  productionDb = getMysqlDb();
  await checkMysqlConnection();
}
