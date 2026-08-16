import assert from "node:assert/strict";
import test from "node:test";

import { resolveCookieSecure } from "../dist/runtime.js";
import { clearSessionCookies, sessionCookies } from "../dist/platform/security.js";

const production = { APP_ENV: "production", DEPLOY_TARGET: "e2e", HOST: "127.0.0.1" };

test("Cookie policy is Secure by default and rejects insecure production or non-loopback configuration", () => {
  assert.equal(resolveCookieSecure({ HOST: "127.0.0.1" }), true);
  assert.throws(() => resolveCookieSecure({ ...production, ALLOW_INSECURE_LOCAL_COOKIES: "true" }), /requires a non-production/u);
  assert.throws(() => resolveCookieSecure({ APP_ENV: "development", HOST: "0.0.0.0", ALLOW_INSECURE_LOCAL_COOKIES: "true" }), /explicit local container runtime/u);
  assert.equal(resolveCookieSecure({ APP_ENV: "local", DEPLOY_TARGET: "local", NODE_ENV: "test", HOST: "0.0.0.0", ALLOW_INSECURE_LOCAL_COOKIES: "true" }), false);
  assert.throws(() => resolveCookieSecure({ APP_ENV: "local", DEPLOY_TARGET: "aliyun", NODE_ENV: "test", HOST: "0.0.0.0", ALLOW_INSECURE_LOCAL_COOKIES: "true" }), /explicit local container runtime/u);
  assert.throws(() => resolveCookieSecure({ APP_ENV: "local", DEPLOY_TARGET: "local", NODE_ENV: "production", HOST: "0.0.0.0", ALLOW_INSECURE_LOCAL_COOKIES: "true" }), /requires a non-production/u);
  assert.throws(() => resolveCookieSecure({ HOST: "127.0.0.1", ALLOW_INSECURE_LOCAL_COOKIES: "maybe" }), /must be true or false/u);
});

test("session, CSRF, refresh/step-up cookie paths share Strict and the selected Secure policy", () => {
  const secure = sessionCookies("signing-key-that-is-long-enough-123456", "a".repeat(64));
  assert.equal(secure.length, 2);
  assert.ok(secure.every((value) => value.includes("Secure") && value.includes("SameSite=Strict")));
  const insecure = [...sessionCookies("signing-key-that-is-long-enough-123456", "a".repeat(64), 100, false), ...clearSessionCookies(false)];
  assert.ok(insecure.every((value) => !value.includes("Secure") && value.includes("SameSite=Strict")));
});
