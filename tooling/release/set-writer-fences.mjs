import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import mysql from "mysql2/promise";

import { RELEASE_MANIFEST } from "./release-manifest.mjs";

const resourcesRaw = process.env.WRITER_ACTIVATION_RESOURCES?.trim() ?? "";
if (resourcesRaw.length === 0) throw new Error("WRITER_ACTIVATION_RESOURCES is empty; no writer fences were changed.");
const resources = resourcesRaw.split(",").map((value) => value.trim());
if (resources.some((value) => value.length === 0)) throw new Error("Writer activation contains an empty resource; no writer fences were changed.");
if (new Set(resources).size !== resources.length) throw new Error("Writer activation contains duplicate resources; no writer fences were changed.");

const manifestResources = new Map(RELEASE_MANIFEST.writer.resources.map((resource) => [resource.resource, resource]));
const unknown = resources.filter((resource) => !manifestResources.has(resource));
if (unknown.length !== 0) throw new Error(`Writer activation contains unknown resources: ${unknown.join(", ")}; no writer fences were changed.`);

const evidencePath = process.argv[2];
if (typeof evidencePath !== "string" || evidencePath.length === 0) {
  throw new Error("Usage: node tooling/release/set-writer-fences.mjs <activation-evidence.json>");
}
const evidenceJson = await readFile(evidencePath, "utf8");
const evidenceHash = process.env.WRITER_ACTIVATION_EVIDENCE_SHA256?.toLowerCase() ?? "";
if (!/^[a-f\d]{64}$/u.test(evidenceHash)) throw new Error("WRITER_ACTIVATION_EVIDENCE_SHA256 must be a SHA-256 digest.");
const actualHash = createHash("sha256").update(evidenceJson, "utf8").digest("hex");
if (actualHash !== evidenceHash) throw new Error("Writer activation evidence hash mismatch; no writer fences were changed.");

let evidence;
try {
  evidence = JSON.parse(evidenceJson);
} catch {
  throw new Error("Writer activation evidence is not valid JSON; no writer fences were changed.");
}
if (evidence?.version !== 1 || evidence.releaseContract !== RELEASE_MANIFEST.contract.id) {
  throw new Error("Writer activation evidence release contract is incompatible.");
}
if (evidence.writerGeneration !== RELEASE_MANIFEST.writer.generation) throw new Error("Writer activation evidence generation is incompatible.");
if (typeof evidence.wave !== "string" || evidence.wave.trim().length === 0) throw new Error("Writer activation evidence must identify a wave.");
if (typeof evidence.releaseTag !== "string" || evidence.releaseTag !== process.env.RELEASE_TAG) throw new Error("Writer activation evidence release tag does not match RELEASE_TAG.");
if (!Array.isArray(evidence.resources) || evidence.resources.length !== resources.length ||
    evidence.resources.some((resource, index) => resource !== resources[index])) {
  throw new Error("Writer activation evidence resources do not exactly match the explicit allowlist.");
}
if (evidence.drain?.pendingCommands !== 0 || evidence.drain?.unknownCommands !== 0 || evidence.drain?.processingOutbox !== 0) {
  throw new Error("Writer activation evidence does not prove a complete drain.");
}
if (evidence.reconciliation?.differences !== 0 || !/^[a-f\d]{64}$/u.test(evidence.reconciliation?.artifactSha256 ?? "")) {
  throw new Error("Writer activation evidence does not prove zero reconciliation differences.");
}
if (typeof evidence.approval?.approvedBy !== "string" || evidence.approval.approvedBy.trim().length === 0 ||
    typeof evidence.approval?.reason !== "string" || evidence.approval.reason.trim().length === 0) {
  throw new Error("Writer activation evidence must record an approver and reason.");
}
if (!Array.isArray(evidence.observability?.checks) || evidence.observability.checks.length === 0 ||
    !/^[a-f\d]{64}$/u.test(evidence.observability?.artifactSha256 ?? "")) {
  throw new Error("Writer activation evidence must include observability checks and an artifact hash.");
}

const url = process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) throw new Error("DATABASE_URL must be mysql://");
const connection = await mysql.createConnection(url);
let committed = false;
try {
  await connection.beginTransaction();
  const [[commandDrain]] = await connection.query(
    `SELECT
       SUM(status = 'pending') AS pendingCommands,
       SUM(status = 'unknown') AS unknownCommands
     FROM command_idempotency`,
  );
  const [[outboxDrain]] = await connection.query(
    "SELECT COUNT(*) AS processingOutbox FROM outbox_messages WHERE status = 'processing'",
  );
  if (Number(commandDrain?.pendingCommands ?? 0) !== 0 || Number(commandDrain?.unknownCommands ?? 0) !== 0 ||
      Number(outboxDrain?.processingOutbox ?? 0) !== 0) {
    throw new Error("Live drain check failed; no writer fences were changed.");
  }

  const placeholders = resources.map(() => "?").join(",");
  const [before] = await connection.query(
    `SELECT resource, owner, enabled, generation FROM writer_fences
     WHERE resource IN (${placeholders}) FOR UPDATE`,
    resources,
  );
  const byResource = new Map(before.map((row) => [row.resource, row]));
  for (const resource of resources) {
    const actual = byResource.get(resource);
    const expected = manifestResources.get(resource);
    if (actual?.owner !== expected.owner || Number(actual?.generation) !== expected.generation) {
      throw new Error(`Writer fence identity mismatch for ${resource}; no writer fences were changed.`);
    }
  }

  const [result] = await connection.query(
    `UPDATE writer_fences SET enabled = 1, updated_at = CURRENT_TIMESTAMP(3)
     WHERE generation = ? AND resource IN (${placeholders}) AND enabled = 0`,
    [RELEASE_MANIFEST.writer.generation, ...resources],
  );
  const [after] = await connection.query(
    `SELECT resource, owner, enabled, generation FROM writer_fences
     WHERE resource IN (${placeholders})`,
    resources,
  );
  const activated = new Map(after.map((row) => [row.resource, row]));
  for (const resource of resources) {
    const row = activated.get(resource);
    const expected = manifestResources.get(resource);
    if (row?.owner !== expected.owner || Number(row?.generation) !== expected.generation || Number(row?.enabled) !== 1) {
      throw new Error(`Writer fence activation verification failed for ${resource}.`);
    }
  }
  await connection.commit();
  committed = true;
  console.log(JSON.stringify({
    activatedResources: resources,
    changedResources: Number(result.affectedRows),
    evidenceSha256: evidenceHash,
    releaseTag: evidence.releaseTag,
    wave: evidence.wave,
  }));
} catch (error) {
  if (!committed) await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
