import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = path.join(root, "archive/manifests/stage9-t2-legacy-source-snapshot.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const snapshotPath = path.join(root, manifest.snapshot.path);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const snapshot = await readFile(snapshotPath);
const snapshotStat = await stat(snapshotPath);
requireCondition(sha256(snapshot) === manifest.snapshot.sha256, "source snapshot SHA-256 changed");
requireCondition(snapshotStat.size === manifest.snapshot.bytes, "source snapshot byte count changed");
requireCondition(manifest.entries.length === 18, "source snapshot must contain exactly 18 route entries");

const listing = execFileSync("tar", ["-tf", snapshotPath], { encoding: "utf8", windowsHide: true })
  .split(/\r?\n/u).filter((member) => member.endsWith("/route.ts"));
requireCondition(listing.length === manifest.entries.length, "source snapshot route member count changed");
requireCondition(listing.every((member) => manifest.entries.some((entry) => entry.path === member)), "source snapshot contains an unmanifested route");

const restoreRoot = await mkdtemp(path.join(tmpdir(), "stage9-t2-legacy-source-"));
try {
  execFileSync("tar", ["-xf", snapshotPath, "-C", restoreRoot], { stdio: "ignore", windowsHide: true });
  const mergedFindings = new Map();
  const patterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
    ["aliyun-access-key", /\bLTAI[A-Za-z\d]{12,}\b/gu],
    ["jwt", /\beyJ[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{10,}\b/gu],
    ["mysql-credential-url", /mysql:\/\/[^\s:/]+:[^\s@/]+@/giu],
  ];
  for (const entry of manifest.entries) {
    const restored = await readFile(path.join(restoreRoot, ...entry.path.split("/")));
    requireCondition(restored.length === entry.bytes, `restored byte count changed: ${entry.path}`);
    requireCondition(sha256(restored) === entry.sha256, `restored SHA-256 changed: ${entry.path}`);
    const source = restored.toString("utf8");
    for (const [kind, expression] of patterns) {
      const occurrences = source.match(expression)?.length ?? 0;
      if (occurrences) mergedFindings.set(kind, (mergedFindings.get(kind) ?? 0) + occurrences);
    }
    const assignment = /\b(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY_SECRET)\b\s*[:=]\s*["']?([^\s"',;}]+)/giu;
    let match;
    let assignmentCount = 0;
    while ((match = assignment.exec(source)) !== null) {
      const value = match[1];
      if (!value || /^(?:replace|example|test-only|changeme|\$\{|process\.env|<)/iu.test(value)) continue;
      assignmentCount += 1;
    }
    if (assignmentCount) mergedFindings.set("secret-like-assignment", (mergedFindings.get("secret-like-assignment") ?? 0) + assignmentCount);
  }
  const findings = [...mergedFindings.entries()].sort().map(([kind, occurrences]) => ({ kind, occurrences }));
  requireCondition(JSON.stringify(findings) === JSON.stringify(manifest.sensitiveScan.findings), "sensitive scan findings changed");
  requireCondition(manifest.sensitiveScan.status === (findings.length ? "review" : "clean"), "sensitive scan status changed");
} finally {
  const resolved = path.resolve(restoreRoot);
  requireCondition(resolved.startsWith(path.resolve(tmpdir(), "stage9-t2-legacy-source-")), "refusing to clean unexpected restore path");
  await rm(resolved, { recursive: true, force: true });
}

const [dockerignore, eslintConfig, webTsconfig, releaseManifest] = await Promise.all([
  readFile(path.join(root, ".dockerignore"), "utf8"),
  readFile(path.join(root, "apps/web/eslint.config.mjs"), "utf8"),
  readFile(path.join(root, "apps/web/tsconfig.json"), "utf8"),
  readFile(path.join(root, "tooling/release/release-manifest.mjs"), "utf8"),
]);
requireCondition(/^archive$/mu.test(dockerignore), "archive must remain outside Docker context");
requireCondition(eslintConfig.includes('"archive/**"'), "archive must remain outside lint closure");
requireCondition(webTsconfig.includes('"../../archive"'), "archive must remain outside Web TypeScript/build closure");
requireCondition(!releaseManifest.includes(manifest.snapshot.path), "source snapshot entered the release manifest");
const runtimeSearch = spawnSync("git", ["grep", "-l", "stage9-t2-legacy-routes-228de77b", "--", "apps", "packages", "database"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
requireCondition(runtimeSearch.status === 0 || runtimeSearch.status === 1, "runtime reference scan failed");
requireCondition(!runtimeSearch.stdout.trim(), "source snapshot is referenced by runtime source");

console.log(`Verified legacy source snapshot: ${manifest.entries.length} routes, ${manifest.snapshot.bytes} bytes, sensitive=${manifest.sensitiveScan.status}, closure=${manifest.closure.join("/")}.`);
