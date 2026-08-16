import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(new URL("../infrastructure/local/docker-compose.yml", import.meta.url), "utf8");
const nginx = readFileSync(new URL("../infrastructure/local/nginx.conf", import.meta.url), "utf8");
const aliyunCompose = readFileSync(new URL("../infrastructure/aliyun/docker-compose.yml", import.meta.url), "utf8");
const webDockerfile = readFileSync(new URL("../infrastructure/docker/web.Dockerfile", import.meta.url), "utf8");
const stub = readFileSync(new URL("../infrastructure/local/stub-provider.mjs", import.meta.url), "utf8");

function service(name) {
  const lines = compose.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing local Compose service: ${name}`);
  const offset = lines.slice(start + 1).findIndex((line) => /^  [a-zA-Z0-9_-]+:$/u.test(line));
  return lines.slice(start, offset === -1 ? lines.length : start + 1 + offset).join("\n");
}

test("local Compose owns the complete self-contained service chain", () => {
  for (const name of ["mysql", "migrator", "bootstrap", "stub", "worker", "api", "app", "nginx"]) service(name);
  assert.match(service("migrator"), /condition: service_healthy/u);
  assert.match(service("bootstrap"), /condition: service_completed_successfully/u);
  assert.match(service("api"), /condition: service_healthy/u);
  assert.match(service("nginx"), /condition: service_healthy/u);
  assert.match(compose, /mysql-data:\s*$/mu);
  assert.match(compose, /file-data:\s*$/mu);
  assert.match(service("api"), /LOCAL_FILE_STORAGE_ROOT: \/var\/lib\/topology-files/u);
  assert.match(service("api"), /file-data:\/var\/lib\/topology-files/u);
  for (const name of ["migrator", "bootstrap", "stub", "worker", "api", "app", "nginx"]) {
    assert.match(service(name), /user: "0:0"/u);
  }
});

test("only Nginx and the optional loopback MySQL debug port are published", () => {
  assert.match(service("nginx"), /127\.0\.0\.1:\$\{LOCAL_HTTP_PORT:-8080\}:80/u);
  assert.match(service("mysql"), /127\.0\.0\.1:\$\{LOCAL_MYSQL_PORT:-3307\}:3306/u);
  for (const name of ["app", "api", "worker", "stub"]) assert.doesNotMatch(service(name), /^    ports:/mu);
});

test("local Nginx is the HTTP owner and routes API and Web without TLS or a test gateway", () => {
  assert.match(nginx, /location \^~ \/api\/v1\//u);
  assert.match(nginx, /proxy_pass http:\/\/api:3001/u);
  assert.match(nginx, /location \/ \{/u);
  assert.match(nginx, /proxy_pass http:\/\/app:3000/u);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto http/u);
  assert.doesNotMatch(nginx, /ssl_certificate|listen 443|https:/u);
  assert.doesNotMatch(compose, /tooling\/e2e\/gateway|v1-development-bridge/u);
});

test("local insecure cookies and provider stub stay out of the Aliyun Compose", () => {
  assert.match(service("api"), /APP_ENV: local/u);
  assert.match(service("api"), /DEPLOY_TARGET: local/u);
  assert.match(service("api"), /ALLOW_INSECURE_LOCAL_COOKIES: "true"/u);
  assert.match(service("api"), /LOCAL_FIXED_OTP_CODE: "123456"/u);
  assert.doesNotMatch(aliyunCompose, /DEPLOY_TARGET: local|ALLOW_INSECURE_LOCAL_COOKIES: "true"|LOCAL_FIXED_OTP_CODE|LOCAL_FILE_STORAGE_ROOT|local-stub/u);
  assert.match(stub, /mode: "local-only"/u);
  assert.doesNotMatch(stub, /E2E_RUN_ID|E2E_STUB_/u);
});

test("the Web runtime binds every container interface so its loopback healthcheck is reachable", () => {
  assert.match(webDockerfile, /^ENV HOSTNAME=0\.0\.0\.0$/mu);
  assert.match(webDockerfile, /HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:3000\/api\/health/u);
});
