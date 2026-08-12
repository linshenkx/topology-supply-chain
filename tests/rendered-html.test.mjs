import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.TEST_BASE_URL ?? "http://localhost:3000";

test("renders only the secure session gate before client authentication", async () => {
  const response = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /拓扑供应链 · 进销存协同系统/);
  assert.match(html, /正在验证安全会话/);
  assert.doesNotMatch(html, /采购管理|财务结算|审批中心/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton|codex-preview/i);
});

test("returns a safe local preview session", async () => {
  const response = await fetch(`${baseUrl}/api/session`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.localPreview, true);
  assert.ok(payload.user.roles.includes("supply_chain"));
  assert.equal(payload.security.passwordAttemptsBeforeLock, 5);
  assert.equal(payload.security.trustedDeviceDays, 90);
});

test("legacy suppliers GET is retired in favor of v1", async () => {
  const response = await fetch(`${baseUrl}/api/suppliers`);
  assert.equal(response.status, 410);
  const payload = await response.json();
  assert.equal(payload.migrationPath, "/api/v1/suppliers");
  assert.match(response.headers.get("link") ?? "", /<\/api\/v1\/suppliers>; rel="successor-version"/u);
});

test("legacy approvals GET is retired in favor of v1", async () => {
  const response = await fetch(`${baseUrl}/api/approvals`);
  assert.equal(response.status, 410);
  const payload = await response.json();
  assert.equal(payload.migrationPath, "/api/v1/approvals");
  assert.match(response.headers.get("link") ?? "", /<\/api\/v1\/approvals>; rel="successor-version"/u);
});
