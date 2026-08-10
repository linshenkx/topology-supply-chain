import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const sourceUrl = new URL("../app/lib/access-boundary.ts", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const testModule = { exports: {} };
vm.runInNewContext(transpiled, {
  module: testModule,
  exports: testModule.exports,
  URL,
  Set,
});
const { isLocalPreviewRequest } = testModule.exports;

test("non-production loopback requests keep the local preview", () => {
  assert.equal(isLocalPreviewRequest({
    requestUrl: "http://127.0.0.1:3000/api/session",
    appEnv: "development",
    deployTarget: "local",
    nodeEnv: "development",
  }), true);
  assert.equal(isLocalPreviewRequest({
    requestUrl: "http://[::1]:3000/api/session",
    nodeEnv: "development",
  }), true);
});

test("production markers defeat a forged localhost Host", () => {
  const forgedUrl = "https://localhost/api/session";
  for (const environment of [
    { appEnv: "production", deployTarget: "local", nodeEnv: "development" },
    { appEnv: "development", deployTarget: "aliyun", nodeEnv: "development" },
    { appEnv: "development", deployTarget: "local", nodeEnv: "production" },
  ]) {
    assert.equal(isLocalPreviewRequest({ requestUrl: forgedUrl, ...environment }), false);
  }
});

test("non-loopback and malformed URLs never receive preview access", () => {
  assert.equal(isLocalPreviewRequest({
    requestUrl: "https://scm.topologygz.com/api/session",
    appEnv: "development",
    nodeEnv: "development",
  }), false);
  assert.equal(isLocalPreviewRequest({
    requestUrl: "not a URL",
    appEnv: "development",
    nodeEnv: "development",
  }), false);
});

test("the application authorization path no longer reads proxy identity headers", () => {
  const authz = fs.readFileSync(new URL("../app/lib/authz.ts", import.meta.url), "utf8");
  assert.doesNotMatch(authz, /oai-authenticated-user-email/i);
});

test("Nginx clears every supported proxy identity header in both locations", () => {
  const nginx = fs.readFileSync(new URL("../deploy/aliyun/nginx-scm.conf", import.meta.url), "utf8");
  for (const header of [
    "oai-authenticated-user-email",
    "oai-authenticated-user-full-name",
    "oai-authenticated-user-full-name-encoding",
  ]) {
    const matches = nginx.match(new RegExp(`proxy_set_header\\s+${header}\\s+\"\";`, "gi"));
    assert.equal(matches?.length, 2, `${header} must be cleared in both proxy locations`);
  }
});
