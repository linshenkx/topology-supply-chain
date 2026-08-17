import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const repositoryRoot = new URL("../../..", import.meta.url);
const clientUrl = new URL("../../../apps/web/app/lib/mutation-client.ts", import.meta.url);

test("pending file scans survive timeout and refresh without another upload", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const values = new Map();
    globalThis.sessionStorage = { getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,value), removeItem:key=>values.delete(key) };
    globalThis.document = { cookie:"topology_csrf="+"b".repeat(64) };
    globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
    let posts = 0, nextFileId = 40, mode = "pending";
    globalThis.fetch = async (url, options={}) => {
      if (String(url) === "/api/v1/files") {
        posts += 1; nextFileId += 1;
        return Response.json({ command:{ command:"files.upload", idempotencyKey:options.headers["idempotency-key"], requestDigest:"a".repeat(64), replayed:false },
          result:{ file:{ id:nextFileId, fileName:"evidence.pdf", scanStatus:"quarantined" }, usable:false } }, { status:201 });
      }
      if (mode === "network") throw new Error("connection reset");
      return Response.json({ id:nextFileId, scanStatus:mode, usable:mode === "clean" });
    };
    const { uploadPlatformFile } = await import(${JSON.stringify(clientUrl.href)});
    const form = name => ({ entries(){ return [["category","invoice"],["entityType","purchase_order"],["entityId","7"],["file",{ name, size:100, lastModified:123 }]][Symbol.iterator](); } });
    let timeoutCode;
    try { await uploadPlatformFile(form("one.pdf")); } catch (error) { timeoutCode = error.code; }
    const pendingAfterTimeout = [...values.values()].some(value => JSON.parse(value).fileId === 41);
    mode = "clean";
    const resumed = await uploadPlatformFile(form("one.pdf"));
    const postsAfterResume = posts;
    mode = "network";
    let networkCode;
    try { await uploadPlatformFile(form("two.pdf")); } catch (error) { networkCode = error.code; }
    const pendingAfterNetwork = [...values.values()].some(value => JSON.parse(value).fileId === 42);
    mode = "clean";
    await uploadPlatformFile(form("two.pdf"));
    const postsAfterNetworkResume = posts;
    mode = "rejected";
    let rejectedCode;
    try { await uploadPlatformFile(form("three.pdf")); } catch (error) { rejectedCode = error.code; }
    process.stdout.write(JSON.stringify({ timeoutCode, pendingAfterTimeout, resumed, postsAfterResume,
      networkCode, pendingAfterNetwork, postsAfterNetworkResume, rejectedCode, remaining:values.size }));
  `], { cwd: repositoryRoot, encoding:"utf8", env:{ ...process.env } });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.timeoutCode, "FILE_SCAN_PENDING");
  assert.equal(body.pendingAfterTimeout, true);
  assert.equal(body.resumed.file.id, 41);
  assert.equal(body.resumed.usable, true);
  assert.equal(body.postsAfterResume, 1);
  assert.equal(body.networkCode, "NETWORK_OUTCOME_UNKNOWN");
  assert.equal(body.pendingAfterNetwork, true);
  assert.equal(body.postsAfterNetworkResume, 2);
  assert.equal(body.rejectedCode, "FILE_SCAN_REJECTED");
  assert.equal(body.remaining, 0);
});

test("proxy 502 preserves the pending mutation key for an outcome-unknown replay", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const values = new Map();
    globalThis.sessionStorage = { getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,value), removeItem:key=>values.delete(key) };
    globalThis.document = { cookie:"topology_csrf="+"b".repeat(64) };
    const keys = [];
    let attempt = 0;
    globalThis.fetch = async (_url, options={}) => {
      keys.push(options.headers["idempotency-key"]); attempt += 1;
      if (attempt === 1) return Response.json({ error:"bad gateway" }, { status:502 });
      return Response.json({ command:{ command:"inventory.reserve", idempotencyKey:keys[0], requestDigest:"a".repeat(64), replayed:true }, result:{ ok:true } });
    };
    const { mutateJson } = await import(${JSON.stringify(clientUrl.href)});
    const payload = { batchId:1, entityType:"historical", requestedQuantity:1 };
    let first;
    try { await mutateJson("/api/v1/inventory", "POST", payload); } catch (error) { first = { code:error.code, key:error.idempotencyKey }; }
    const pendingAfter502 = values.size;
    const replay = await mutateJson("/api/v1/inventory", "POST", payload);
    process.stdout.write(JSON.stringify({ first, pendingAfter502, keys, replay, remaining:values.size }));
  `], { cwd: repositoryRoot, encoding:"utf8", env:{ ...process.env } });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.first.code, "NETWORK_OUTCOME_UNKNOWN");
  assert.equal(body.pendingAfter502, 1);
  assert.equal(body.keys[0], body.keys[1]);
  assert.deepEqual(body.replay, { ok:true });
  assert.equal(body.remaining, 0);
});

test("password account lifecycle paths leave request digests to the server", () => {
  const cases = [
    ["/api/v1/users/accounts", "users.create", {
      email: "user@example.com", initialPassword: "InitialPass!234", mobile: "13800138009",
      name: "User", organizationName: "Topology", roleCode: "receiver",
    }],
    ["/api/v1/users/password-reset", "users.reset-password", {
      newPassword: "Replacement!234", userId: 12,
    }],
    ["/api/v1/users/disable", "users.disable", { userId: 12 }],
    ["/api/v1/users/restore", "users.restore", { userId: 12 }],
  ];
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const values = new Map();
    const pendingIds = [];
    globalThis.sessionStorage = { getItem:key=>values.get(key) ?? null, setItem:(key,value)=>{ pendingIds.push(key); values.set(key,value); }, removeItem:key=>values.delete(key) };
    globalThis.document = { cookie:"topology_csrf="+"b".repeat(64) };
    const calls = [];
    const commands = new Map(${JSON.stringify(cases.map(([path, command]) => [path, command]))});
    globalThis.fetch = async (url, options={}) => {
      const command = commands.get(String(url));
      calls.push({ url:String(url), digest:options.headers["x-request-digest"], command });
      return Response.json({ command:{ command, idempotencyKey:options.headers["idempotency-key"], requestDigest:options.headers["x-request-digest"], replayed:false }, result:{ ok:true } });
    };
    const { mutateJson } = await import(${JSON.stringify(clientUrl.href)});
    for (const [path, _command, payload] of ${JSON.stringify(cases)}) await mutateJson(path, "POST", payload);
    await mutateJson("/api/v1/users/accounts", "POST", { ...${JSON.stringify(cases[0][2])}, initialPassword:"DifferentPass!567" });
    process.stdout.write(JSON.stringify({ calls, pendingIds, remaining:values.size }));
  `], { cwd: repositoryRoot, encoding:"utf8", env:{ ...process.env } });

  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.remaining, 0);
  assert.deepEqual(body.calls.slice(0, cases.length).map(({ url, command }) => [url, command]),
    cases.map(([url, command]) => [url, command]));
  assert.equal(body.calls[0].digest, undefined);
  assert.equal(body.calls[1].digest, undefined);
  assert.equal(body.pendingIds[0], body.pendingIds.at(-1), "password changes must not create a fast-hash pending key");
  for (const [index, [, command, payload]] of cases.entries()) {
    if (index < 2) continue;
    const expected = createHash("sha256")
      .update(JSON.stringify({ command, payload }), "utf8")
      .digest("hex");
    assert.equal(body.calls[index].digest, expected, command);
  }
});
