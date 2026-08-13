import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const sourcePath = path.join(root, "database", "runtime", "schema.ts");
const targetPath = path.join(root, "database", "runtime", "schema.mysql.generated.ts");

let source = fs.readFileSync(sourcePath, "utf8");
const indexedTextColumns = new Set([
  "code",
  "email",
  "order_no",
  "sku",
  "execution_no",
  "request_no",
  "invoice_no",
  "return_no",
  "risk_no",
  "batch_no",
  "stocktake_no",
  "transfer_no",
  "object_key",
  "import_no",
  "challenge_no",
  "token_hash",
  "component_sku",
  "purchase_unit",
  "effective_from",
  "finished_sku",
  "version",
  "plan_no",
  "expected_arrival_date",
  "planned_payment_date",
  "type",
  "verifier_role",
  "device_id",
  "quarter",
  "review_type",
  "resource",
  "owner",
  "command_name",
  "actor_scope",
  "idempotency_key",
  "request_digest",
  "deduplication_key",
  "aggregate_type",
  "aggregate_id",
  "topic",
  "resource_type",
  "resource_id",
  "scan_status",
  "content_sha256",
  "object_type",
  "object_id",
  "key_type",
  "key_value",
  "source_key",
  "bucket",
]);
source = source
  .replace(
    'import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";',
    'import { bigint, boolean, datetime, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";',
  )
  .replaceAll("sqliteTable(", "mysqlTable(")
  .replace(
    /integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\)/g,
    'int("id").autoincrement().primaryKey()',
  )
  .replace(
    /integer\(("[^"]+"), \{ mode: "boolean" \}\)/g,
    "boolean($1)",
  )
  .replaceAll("integer(", "int(");

source = source.replace(
  /text\("([^"]+)"(,\s*\{\s*enum:\s*\[[^\]]+\]\s*\})?\)/g,
  (match, columnName, enumConfig) => {
    if (!indexedTextColumns.has(columnName)) return match;
    if (enumConfig) {
      return `varchar("${columnName}", ${enumConfig.replace(/^,\s*/, "").replace(
        /\{\s*enum:/,
        "{ length: 191, enum:",
      )})`;
    }
    return `varchar("${columnName}", { length: 191 })`;
  },
);
source = source.replace(
  'objectVersion: int("object_version"),',
  'objectVersion: bigint("object_version", { mode: "number" }),',
);
source = source
  .replace('keyType: varchar("key_type", { length: 191 })', 'keyType: varchar("key_type", { length: 64 })')
  .replace('bucket: varchar("bucket", { length: 191 })', 'bucket: varchar("bucket", { length: 32 })');
source = source.replace(
  /text\("([^"]+)"\)\.notNull\(\)\.default\(sql`CURRENT_TIMESTAMP`\)/g,
  'datetime("$1", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`)',
);

const banner = `/*
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 * Source: database/runtime/schema.ts
 * Command: pnpm db:generate:mysql-schema
 *
 * This is the RDS MySQL table-model baseline. API migration also needs to replace
 * SQLite-only SQL expressions and emulate INSERT ... RETURNING with insertId/select.
 */
`;
fs.writeFileSync(targetPath, `${banner}${source}`, "utf8");
console.log(`Generated ${path.relative(root, targetPath)}`);
