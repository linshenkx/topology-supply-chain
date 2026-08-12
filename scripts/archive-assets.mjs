import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildArchivedRestorePlan } from "./archive-restore-contract.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = path.join(repositoryRoot, "archive", "manifests", "assets.json");
const baseline = "db63839bcd4ce8c852a18310f1f0ef7bca83c269";
const categoryOrder = ["legacy-deliveries", "deliveries", "working-notes", "diagrams"];

function repositoryPath(relativePath) {
  const resolved = path.resolve(repositoryRoot, relativePath);
  const relation = path.relative(repositoryRoot, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Path escapes repository boundary: ${relativePath}`);
  }
  return resolved;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

async function filesUnder(relativeRoot) {
  const absoluteRoot = repositoryPath(relativeRoot);
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(slash(path.relative(repositoryRoot, absolute)));
      else throw new Error(`Unsupported asset type: ${slash(path.relative(repositoryRoot, absolute))}`);
    }
  }
  await visit(absoluteRoot);
  return result;
}

async function plannedEntries() {
  const rootNames = (await readdir(repositoryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^topology-scm-.*\.tar\.gz$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const mappings = [
    ...rootNames.map((source) => ({ category: "legacy-deliveries", source, target: `archive/legacy-deliveries/${source}` })),
    ...(await filesUnder("outputs")).map((source) => ({ category: "deliveries", source, target: `archive/deliveries/${source.slice("outputs/".length)}` })),
    ...(await filesUnder(".tmp")).map((source) => ({ category: "working-notes", source, target: `archive/working-notes/${source.slice(".tmp/".length)}` })),
    ...(await filesUnder("work")).map((source) => ({ category: "diagrams", source, target: `archive/diagrams/${source.slice("work/".length)}` })),
  ];
  const seenTargets = new Set();
  return mappings.sort((left, right) => left.source.localeCompare(right.source, "en")).map((mapping) => {
    repositoryPath(mapping.source);
    repositoryPath(mapping.target);
    if (seenTargets.has(mapping.target)) throw new Error(`Duplicate archive target: ${mapping.target}`);
    seenTargets.add(mapping.target);
    return { ...mapping, status: "planned", evidence: null };
  });
}

async function saveManifest(manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.baseline !== baseline || !Array.isArray(manifest.entries)) {
    throw new Error("Archive manifest schema or baseline is invalid");
  }
  return manifest;
}

async function sha256(absolutePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sensitivityFindings(buffer) {
  const source = buffer.toString("utf8");
  const findings = [];
  const patterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
    ["aliyun-access-key", /\bLTAI[A-Za-z\d]{12,}\b/gu],
    ["jwt", /\beyJ[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{10,}\b/gu],
    ["mysql-credential-url", /mysql:\/\/[^\s:/]+:[^\s@/]+@/giu],
  ];
  for (const [kind, expression] of patterns) {
    const matches = source.match(expression);
    if (matches?.length) findings.push({ kind, occurrences: matches.length });
  }
  const assignment = /\b(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY_SECRET)\b\s*[:=]\s*["']?([^\s"',;}]+)/giu;
  let assigned;
  let assignmentCount = 0;
  while ((assigned = assignment.exec(source)) !== null) {
    const value = assigned[1];
    if (!value || /^(?:replace|example|test-only|changeme|\$\{|process\.env|<)/iu.test(value)) continue;
    assignmentCount += 1;
  }
  if (assignmentCount) findings.push({ kind: "secret-like-assignment", occurrences: assignmentCount });
  return findings;
}

function mergeFindings(target, findings) {
  for (const finding of findings) target.set(finding.kind, (target.get(finding.kind) ?? 0) + finding.occurrences);
}

async function walkAbsolute(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkAbsolute(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function archiveLike(relativePath) {
  return /\.(?:tar\.gz|tgz|zip|xlsx)$/iu.test(relativePath);
}

async function scanAsset(relativePath) {
  const absolute = repositoryPath(relativePath);
  const merged = new Map();
  mergeFindings(merged, sensitivityFindings(await readFile(absolute)));
  if (archiveLike(relativePath)) {
    const extractionRoot = await mkdtemp(path.join(tmpdir(), "codex-t1-archive-scan-"));
    try {
      const listing = execFileSync("tar", ["-tf", absolute], { encoding: "utf8", windowsHide: true });
      for (const member of listing.split(/\r?\n/u).filter(Boolean)) {
        const normalized = member.replaceAll("\\", "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) || normalized.split("/").includes("..")) {
          throw new Error(`Unsafe archive member in ${relativePath}`);
        }
      }
      execFileSync("tar", ["-xf", absolute, "-C", extractionRoot], { stdio: "ignore", windowsHide: true });
      for (const extracted of await walkAbsolute(extractionRoot)) {
        mergeFindings(merged, sensitivityFindings(await readFile(extracted)));
      }
    } finally {
      const resolvedTemp = path.resolve(extractionRoot);
      const expectedPrefix = path.resolve(tmpdir(), "codex-t1-archive-scan-");
      if (!resolvedTemp.startsWith(expectedPrefix)) throw new Error(`Refusing to clean unexpected temp path: ${resolvedTemp}`);
      await rm(resolvedTemp, { recursive: true, force: true });
    }
  }
  const findings = [...merged.entries()].sort().map(([kind, occurrences]) => ({ kind, occurrences }));
  return { status: findings.length ? "review" : "clean", findings };
}

async function trackedTextFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot });
  const names = output.toString("utf8").split("\0").filter(Boolean)
    .filter((name) => !name.startsWith("archive/manifests/"));
  const result = [];
  for (const name of names) {
    const buffer = await readFile(repositoryPath(name));
    if (buffer.includes(0)) continue;
    result.push([slash(name), buffer.toString("utf8")]);
  }
  return result;
}

async function commandPlan() {
  try {
    await stat(manifestPath);
    throw new Error("Planned manifest already exists; refusing to replace it");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = await plannedEntries();
  const totals = Object.fromEntries(categoryOrder.map((category) => [category, entries.filter((entry) => entry.category === category).length]));
  await saveManifest({ schemaVersion: 1, baseline, status: "planned", totals, restoreDryRun: null, entries });
  console.log(`Planned ${entries.length} assets without moving or inspecting content.`);
}

async function commandInspect() {
  const manifest = await loadManifest();
  if (manifest.status !== "planned" || manifest.entries.some((entry) => entry.status !== "planned")) {
    throw new Error("Inspection requires an untouched planned manifest");
  }
  const trackedFiles = await trackedTextFiles();
  let reviewCount = 0;
  for (const entry of manifest.entries) {
    const absolute = repositoryPath(entry.source);
    const metadata = await stat(absolute);
    const sensitivity = await scanAsset(entry.source);
    if (sensitivity.status === "review") reviewCount += 1;
    const references = trackedFiles
      .filter(([, content]) => content.includes(entry.source) || (entry.category === "legacy-deliveries" && content.includes(path.basename(entry.source))))
      .map(([name]) => name);
    entry.evidence = {
      sha256: await sha256(absolute),
      bytes: metadata.size,
      mtimeUtc: metadata.mtime.toISOString(),
      references,
      sensitiveScan: sensitivity,
    };
    entry.status = "inspected";
  }
  manifest.status = "inspected";
  manifest.inspection = { assets: manifest.entries.length, reviewRequired: reviewCount };
  await saveManifest(manifest);
  console.log(`Inspected ${manifest.entries.length} assets; ${reviewCount} remain protected for sensitivity review.`);
}

async function commandRestoreDryRun() {
  const manifest = await loadManifest();
  if (manifest.status === "archived") {
    const plan = await buildArchivedRestorePlan(manifest, repositoryRoot);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (manifest.entries.some((entry) => entry.status !== "inspected" || !entry.evidence?.sha256)) {
    throw new Error("Restore dry-run requires uniformly inspected or archived assets");
  }
  const restoreRoot = await mkdtemp(path.join(tmpdir(), "codex-t1-archive-restore-"));
  try {
    for (const entry of manifest.entries) {
      const restored = path.join(restoreRoot, ...entry.source.split("/"));
      await mkdir(path.dirname(restored), { recursive: true });
      await copyFile(repositoryPath(entry.source), restored);
      if (await sha256(restored) !== entry.evidence.sha256) throw new Error(`Restore hash mismatch: ${entry.source}`);
    }
  } finally {
    const resolvedTemp = path.resolve(restoreRoot);
    const expectedPrefix = path.resolve(tmpdir(), "codex-t1-archive-restore-");
    if (!resolvedTemp.startsWith(expectedPrefix)) throw new Error(`Refusing to clean unexpected temp path: ${resolvedTemp}`);
    await rm(resolvedTemp, { recursive: true, force: true });
  }
  manifest.restoreDryRun = { status: "passed", verifiedAssets: manifest.entries.length };
  await saveManifest(manifest);
  console.log(`Restore dry-run verified ${manifest.entries.length} assets by SHA-256.`);
}

async function commandMove(category) {
  if (!categoryOrder.includes(category)) throw new Error(`Unknown archive category: ${category}`);
  const manifest = await loadManifest();
  if (manifest.restoreDryRun?.status !== "passed") throw new Error("Move requires a passed restore dry-run");
  const selected = manifest.entries.filter((entry) => entry.category === category);
  if (!selected.length || selected.some((entry) => entry.status !== "inspected")) {
    throw new Error(`Category ${category} is empty or not uniformly inspected`);
  }
  const moved = [];
  try {
    for (const entry of selected) {
      const source = repositoryPath(entry.source);
      const target = repositoryPath(entry.target);
      if (await sha256(source) !== entry.evidence.sha256) throw new Error(`Source changed after inspection: ${entry.source}`);
      try {
        await stat(target);
        throw new Error(`Archive target already exists: ${entry.target}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.reverse()) await rename(repositoryPath(entry.target), repositoryPath(entry.source));
    throw error;
  }
  for (const entry of selected) entry.status = "archived";
  manifest.status = manifest.entries.every((entry) => entry.status === "archived") ? "archived" : "partially-archived";
  await saveManifest(manifest);
  await commandVerify(false);
  console.log(`Archived ${selected.length} ${category} assets with reversible source-to-target mappings.`);
}

async function commandVerify(print = true) {
  const manifest = await loadManifest();
  for (const entry of manifest.entries) {
    const relative = entry.status === "archived" ? entry.target : entry.source;
    const absolute = repositoryPath(relative);
    const metadata = await stat(absolute);
    if (
      metadata.size !== entry.evidence?.bytes
      || metadata.mtime.toISOString() !== entry.evidence?.mtimeUtc
      || await sha256(absolute) !== entry.evidence?.sha256
    ) {
      throw new Error(`Archive evidence mismatch: ${relative}`);
    }
    if (entry.status === "archived") {
      try {
        await stat(repositoryPath(entry.source));
        throw new Error(`Archived source still exists: ${entry.source}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  if (print) console.log(`Verified ${manifest.entries.length} manifest assets; state=${manifest.status}.`);
}

const [command, argument] = process.argv.slice(2);
if (command === "plan") await commandPlan();
else if (command === "inspect") await commandInspect();
else if (command === "restore-dry-run") await commandRestoreDryRun();
else if (command === "move") await commandMove(argument);
else if (command === "verify") await commandVerify();
else {
  console.error("Usage: node scripts/archive-assets.mjs <plan|inspect|restore-dry-run|move CATEGORY|verify>");
  process.exit(2);
}
