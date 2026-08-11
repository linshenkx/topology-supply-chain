import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/server.ts", import.meta.url);
const providersUrl = new URL("../src/providers.ts", import.meta.url);

test("worker claims outbox messages with a lease and MySQL skip-locked semantics", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /FOR UPDATE SKIP LOCKED/u);
  assert.match(source, /status = 'processing'/u);
  assert.match(source, /locked_by = \?/u);
  assert.match(source, /locked_at < \?/u);
  assert.match(source, /attempts = attempts \+ 1/u);
  assert.match(source, /LEASE_EXHAUSTED/u);
  assert.match(source, /attempts >= max_attempts/u);
  assert.match(source, /generation.*writerGeneration/u);
  assert.match(source, /class FencePaused/u);
  assert.match(source, /attempts = GREATEST\(attempts - 1, 0\)/u);
  assert.match(source, /if \(error instanceof FencePaused\) await pause/u);
});

test("worker has retry, dead-letter, and provider idempotency boundaries", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const providers = await readFile(providersUrl, "utf8");

  assert.match(source, /dead \? "dead" : "pending"/u);
  assert.match(source, /row\.attempts >= row\.maxAttempts/u);
  assert.match(providers, /"idempotency-key"/u);
  assert.match(source, /emailDeduplicationKey/u);
  assert.match(source, /WHERE deduplication_key = \? LIMIT 1 FOR UPDATE/u);
  assert.match(providers, /AbortSignal\.timeout\(15_000\)/u);
  assert.match(source, /scanFile\(providers/u);
  assert.match(source, /scan_status = \?/u);
  assert.ok(source.indexOf('requireFence(pool, "outbox.worker")') < source.indexOf("deliverEmail(providers"));
  assert.ok(source.indexOf('requireFence(pool, "files.worker")') < source.indexOf("scanFile(providers"));
});

test("worker exposes only health HTTP endpoints and owns reminder execution", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /request\.url === "\/health\/live"/u);
  assert.match(source, /request\.url === "\/health\/ready"/u);
  assert.match(source, /requireWorkerFences\(pool\)/u);
  for (const fence of ["outbox.worker", "reminders.worker", "files.worker"]) assert.match(source, new RegExp(fence.replace(".", "\\."), "u"));
  assert.doesNotMatch(source, /\/api\/jobs/u);
  assert.match(source, /async function sweepReminder/u);
  assert.match(source, /process_reminder/u);
});
