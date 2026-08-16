import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildArchivedRestorePlan } from "../tooling/archive/archive-restore-contract.mjs";
import { executeArchivedRestorePlan } from "../tooling/archive/execute-archive-restore-plan.mjs";
import { assertTapHasNoSkips, tapHasSkips } from "../tooling/checks/tap-skip.mjs";

async function archiveFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "archive-restore-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetRelative = "archive/deliveries/evidence.txt";
  const target = path.join(root, ...targetRelative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "preserved evidence\n", "utf8");
  const fixedMtime = new Date("2026-08-13T00:00:00.000Z");
  await utimes(target, fixedMtime, fixedMtime);
  const content = await readFile(target);
  const metadata = await stat(target);
  const manifest = {
    schemaVersion: 1,
    status: "archived",
    entries: [{
      category: "deliveries",
      source: "outputs/evidence.txt",
      target: targetRelative,
      status: "archived",
      evidence: {
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: metadata.size,
        mtimeUtc: metadata.mtime.toISOString(),
      },
    }],
  };
  return { root, target, manifest };
}

test("archived restore dry-run is read-only and returns an exclusive recovery plan", async (t) => {
  const { root, target, manifest } = await archiveFixture(t);
  const before = await stat(target);
  const plan = await buildArchivedRestorePlan(manifest, root);

  assert.equal(plan.writePerformed, false);
  assert.equal(plan.executor, "node tooling/archive/execute-archive-restore-plan.mjs <plan.json>");
  assert.equal(plan.preconditions.archivedSourcesVerified, 1);
  assert.deepEqual(plan.createDirectories, ["outputs"]);
  assert.deepEqual(plan.operations[0], {
    operation: "copy-exclusive-preserve-mtime",
    from: "archive/deliveries/evidence.txt",
    to: "outputs/evidence.txt",
    ...manifest.entries[0].evidence,
  });
  await assert.rejects(stat(path.join(root, "outputs/evidence.txt")), { code: "ENOENT" });
  const after = await stat(target);
  assert.equal(after.size, before.size);
  assert.equal(after.mtime.toISOString(), before.mtime.toISOString());
});

test("archived restore plan executes by exclusive copy and refuses overwrite", async (t) => {
  const fixture = await archiveFixture(t);
  const plan = await buildArchivedRestorePlan(fixture.manifest, fixture.root);
  const result = await executeArchivedRestorePlan(plan, fixture.root);
  assert.deepEqual(result, { restoredAssets: 1, overwriteAllowed: false });
  assert.equal(await readFile(path.join(fixture.root, "outputs/evidence.txt"), "utf8"), "preserved evidence\n");
  await assert.rejects(executeArchivedRestorePlan(plan, fixture.root), /destination already exists/u);
});

test("archived restore dry-run rejects missing, changed, and conflicting assets", async (t) => {
  await t.test("missing archived target", async (t) => {
    const fixture = await archiveFixture(t);
    await rm(fixture.target);
    await assert.rejects(buildArchivedRestorePlan(fixture.manifest, fixture.root), /source is missing/u);
  });
  for (const [name, mutate, expected] of [
    ["byte count", (entry) => { entry.evidence.bytes += 1; }, /byte count mismatch/u],
    ["mtime", (entry) => { entry.evidence.mtimeUtc = "2026-08-12T00:00:00.000Z"; }, /mtime mismatch/u],
    ["hash", (entry) => { entry.evidence.sha256 = "0".repeat(64); }, /SHA-256 mismatch/u],
  ]) {
    await t.test(name, async (t) => {
      const fixture = await archiveFixture(t);
      mutate(fixture.manifest.entries[0]);
      await assert.rejects(buildArchivedRestorePlan(fixture.manifest, fixture.root), expected);
    });
  }
  await t.test("existing restore destination", async (t) => {
    const fixture = await archiveFixture(t);
    const source = path.join(fixture.root, "outputs/evidence.txt");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "conflict", "utf8");
    await assert.rejects(buildArchivedRestorePlan(fixture.manifest, fixture.root), /destination already exists/u);
  });
});

test("TAP zero-skip runners share fail-closed detection for standard directives and summaries", async () => {
  for (const output of [
    "ok 1 - optional integration # SKIP missing database\n",
    "    # SKIP platform unavailable\n",
    "# skipped 2\n",
  ]) {
    assert.equal(tapHasSkips(output), true);
    assert.throws(() => assertTapHasNoSkips(output, "fixture suite"), /skip is not a passing gate/u);
  }
  assert.equal(tapHasSkips("ok 1 - active test\n# skipped 0\n"), false);
  assert.doesNotThrow(() => assertTapHasNoSkips("ok 1 - active test\n# skipped 0\n", "fixture suite"));
  const suiteRunner = await readFile(new URL("../tooling/checks/run-test-suite.mjs", import.meta.url), "utf8");
  const webRunner = await readFile(new URL("../tooling/checks/run-web-system-test.mjs", import.meta.url), "utf8");
  assert.match(suiteRunner, /import \{ assertTapHasNoSkips \} from "\.\/tap-skip\.mjs"/u);
  assert.match(webRunner, /import \{ assertTapHasNoSkips \} from "\.\/tap-skip\.mjs"/u);
  for (const source of [suiteRunner, webRunner]) {
    assert.match(source, /assertTapHasNoSkips\(result\.stdout \?\? ""/u);
  }
});

test("CI prepares its ignored environment file and keeps explicit E2E suites out of the MySQL gate", async () => {
  const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
  const suiteRunner = await readFile(new URL("../tooling/checks/run-test-suite.mjs", import.meta.url), "utf8");
  const environmentCheck = await readFile(new URL("../tooling/checks/check-environment-contract.mjs", import.meta.url), "utf8");

  assert.match(
    workflow,
    /cp infrastructure\/aliyun\/\.env\.production\.template infrastructure\/aliyun\/\.env\.production/u,
  );
  assert.match(suiteRunner, /const e2eIntegration = .*name\.startsWith\("e2e-"\)/u);
  assert.match(suiteRunner, /const mysqlIntegration = .*&& !e2eIntegration\(name\)/u);
  assert.match(suiteRunner, /suite === "mysql" \? mysqlIntegration\(entry\.name\)/u);
  assert.match(suiteRunner, /"--experimental-strip-types",\s+"--test"/u);
  assert.match(environmentCheck, /"--env-file", fileURLToPath\(templateUrl\)/u);
  assert.match(environmentCheck, /backend: "backend"/u);
  assert.match(environmentCheck, /migrator: "migrator"/u);
  assert.match(environmentCheck, /must use an explicit environment allowlist/u);
  assert.doesNotMatch(environmentCheck, /services\.preflight/u);
});
