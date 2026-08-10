import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "db", "schema.ts");
const targetPath = path.join(root, "db", "schema.mysql.generated.ts");

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
]);
source = source
  .replace(
    'import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";',
    'import { boolean, datetime, int, mysqlTable, serial, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";',
  )
  .replaceAll("sqliteTable(", "mysqlTable(")
  .replace(
    /integer\("id"\)\.primaryKey\(\{ autoIncrement: true \}\)/g,
    'serial("id").primaryKey()',
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
  /text\("([^"]+)"\)\.notNull\(\)\.default\(sql`CURRENT_TIMESTAMP`\)/g,
  'datetime("$1", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`)',
);

const banner = `/*
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 * Source: db/schema.ts
 * Command: npm run db:generate:mysql-schema
 *
 * This is the RDS MySQL table-model baseline. API migration also needs to replace
 * SQLite-only SQL expressions and emulate INSERT ... RETURNING with insertId/select.
 */
`;
fs.writeFileSync(targetPath, `${banner}${source}`, "utf8");
console.log(`Generated ${path.relative(root, targetPath)}`);
