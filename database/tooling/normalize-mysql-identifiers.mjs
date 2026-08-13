import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const migrationDirectory = path.join(root, "database", "migrations", "mysql");
const maximumIdentifierLength = 64;
const readablePrefixLength = 47;
const simpleIdentifier = /[A-Za-z_][A-Za-z0-9_]{64,}/gu;

function shortened(identifier) {
  if (identifier.length <= maximumIdentifierLength) return identifier;
  const digest = createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 16);
  return `${identifier.slice(0, readablePrefixLength)}_${digest}`;
}

function normalizeFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const normalized = source.replace(simpleIdentifier, shortened);
  if (normalized !== source) fs.writeFileSync(filePath, normalized, "utf8");
}

for (const fileName of fs.readdirSync(migrationDirectory)) {
  if (fileName.endsWith(".sql")) {
    normalizeFile(path.join(migrationDirectory, fileName));
  }
}
const metadataDirectory = path.join(migrationDirectory, "meta");
for (const fileName of fs.readdirSync(metadataDirectory)) {
  if (fileName.endsWith("_snapshot.json")) {
    normalizeFile(path.join(metadataDirectory, fileName));
  }
}

// Drizzle derives implicit foreign-key names from table/column names. MySQL's
// 64-byte identifier limit requires the deterministic shortening above, but a
// subsequent generate compares the long derived names with the shortened
// snapshot and can emit a migration that only drops and re-adds the exact same
// normalized constraints. Remove only that provable no-op tail; any column,
// index, data, or differently named constraint statement keeps the migration.
const journalPath = path.join(metadataDirectory, "_journal.json");
function removeTrailingConstraintRenameNoOp() {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entry = journal.entries?.at(-1);
  if (!entry) return false;
  const sqlPath = path.join(migrationDirectory, `${entry.tag}.sql`);
  if (!fs.existsSync(sqlPath)) return false;
  const statements = fs.readFileSync(sqlPath, "utf8")
    .split("--> statement-breakpoint")
    .map(value => value.trim())
    .filter(Boolean);
  if (statements.length === 0) return false;
  const dropped = new Set();
  const added = new Set();
  for (const statement of statements) {
    const drop = /^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`;$/u.exec(statement);
    if (drop) { dropped.add(`${drop[1]}:${drop[2]}`); continue; }
    const add = /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY /u.exec(statement);
    if (add) { added.add(`${add[1]}:${add[2]}`); continue; }
    return false;
  }
  if (dropped.size === 0 || dropped.size !== added.size ||
      [...dropped].some(value => !added.has(value))) return false;
  fs.unlinkSync(sqlPath);
  const snapshotPath = path.join(metadataDirectory, `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
  if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
  journal.entries.pop();
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  console.log(`Removed generated MySQL constraint-name no-op ${entry.tag}.`);
  return true;
}

while (removeTrailingConstraintRenameNoOp()) {
  // Collapse any no-op tail left by earlier interrupted generator runs.
}

console.log("Normalized MySQL identifiers to 64 characters or fewer.");
