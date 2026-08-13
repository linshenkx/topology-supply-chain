import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildArchivedRestorePlan } from "./archive-restore-contract.mjs";

function inside(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relation = path.relative(root, absolute);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Restore path escapes repository boundary: ${relativePath}`);
  }
  return absolute;
}

async function sha256(absolutePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function executeArchivedRestorePlan(plan, repositoryRoot) {
  if (plan.schemaVersion !== 1 || plan.mode !== "archived-restore" || plan.writePerformed !== false) {
    throw new Error("Invalid archived restore plan");
  }
  const manifest = {
    status: "archived",
    entries: plan.operations.map((operation) => ({
      status: "archived",
      source: operation.to,
      target: operation.from,
      evidence: {
        sha256: operation.sha256,
        bytes: operation.bytes,
        mtimeUtc: operation.mtimeUtc,
      },
    })),
  };
  const verified = await buildArchivedRestorePlan(manifest, repositoryRoot);
  if (JSON.stringify(verified.operations) !== JSON.stringify(plan.operations)) {
    throw new Error("Restore plan changed after preflight");
  }

  for (const operation of plan.operations) {
    const source = inside(repositoryRoot, operation.from);
    const destination = inside(repositoryRoot, operation.to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const restoredMtime = new Date(operation.mtimeUtc);
    await utimes(destination, restoredMtime, restoredMtime);
    const metadata = await stat(destination);
    if (
      metadata.size !== operation.bytes
      || metadata.mtime.toISOString() !== operation.mtimeUtc
      || await sha256(destination) !== operation.sha256
    ) throw new Error(`Restored asset verification failed: ${operation.to}`);
  }
  return { restoredAssets: plan.operations.length, overwriteAllowed: false };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error("Usage: node tooling/archive/execute-archive-restore-plan.mjs <plan.json>");
    process.exit(2);
  }
  const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8"));
  const result = await executeArchivedRestorePlan(plan, repositoryRoot);
  console.log(`Restored ${result.restoredAssets} assets with exclusive copy and evidence verification.`);
}
