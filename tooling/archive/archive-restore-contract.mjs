import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

function inside(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relation = path.relative(root, absolute);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Restore path escapes repository boundary: ${relativePath}`);
  }
  return absolute;
}

async function hashFile(absolutePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function missing(absolutePath) {
  try {
    await lstat(absolutePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function restorableParent(root, relativeSource, directories) {
  const parent = path.dirname(relativeSource);
  if (parent === ".") return;
  let current = root;
  for (const segment of parent.split(/[\\/]/u)) {
    current = path.join(current, segment);
    if (await missing(current)) {
      directories.add(path.relative(root, current).split(path.sep).join("/"));
      continue;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Restore parent is not a real directory: ${path.relative(root, current)}`);
    }
  }
}

export async function buildArchivedRestorePlan(manifest, repositoryRoot) {
  if (manifest.status !== "archived" || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Archived restore dry-run requires a non-empty archived manifest");
  }
  const directories = new Set();
  const sources = new Set();
  const targets = new Set();
  const operations = [];

  for (const entry of manifest.entries) {
    if (entry.status !== "archived" || !entry.evidence?.sha256) {
      throw new Error(`Archived restore entry is incomplete: ${entry.source ?? "<unknown>"}`);
    }
    if (sources.has(entry.source) || targets.has(entry.target)) {
      throw new Error(`Duplicate restore mapping: ${entry.source} -> ${entry.target}`);
    }
    sources.add(entry.source);
    targets.add(entry.target);

    const source = inside(repositoryRoot, entry.source);
    const target = inside(repositoryRoot, entry.target);
    if (!await missing(source)) throw new Error(`Restore destination already exists: ${entry.source}`);
    await restorableParent(repositoryRoot, entry.source, directories);

    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Archived restore source is missing: ${entry.target}`);
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Archived restore source is not a regular file: ${entry.target}`);
    }
    if (metadata.size !== entry.evidence.bytes) {
      throw new Error(`Archived restore byte count mismatch: ${entry.target}`);
    }
    if (metadata.mtime.toISOString() !== entry.evidence.mtimeUtc) {
      throw new Error(`Archived restore mtime mismatch: ${entry.target}`);
    }
    if (await hashFile(target) !== entry.evidence.sha256) {
      throw new Error(`Archived restore SHA-256 mismatch: ${entry.target}`);
    }
    operations.push({
      operation: "copy-exclusive-preserve-mtime",
      from: entry.target,
      to: entry.source,
      sha256: entry.evidence.sha256,
      bytes: entry.evidence.bytes,
      mtimeUtc: entry.evidence.mtimeUtc,
    });
  }

  return {
    schemaVersion: 1,
    mode: "archived-restore",
    writePerformed: false,
    executor: "node tooling/archive/execute-archive-restore-plan.mjs <plan.json>",
    preconditions: {
      archivedSourcesVerified: operations.length,
      restoreDestinationsAbsent: operations.length,
      destinationParentsRestorable: true,
      overwriteAllowed: false,
    },
    createDirectories: [...directories].sort(),
    operations,
  };
}
