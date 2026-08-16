import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const backendDockerfile = read("infrastructure/docker/api.Dockerfile");
const webDockerfile = read("infrastructure/docker/web.Dockerfile");
const compose = read("infrastructure/aliyun/docker-compose.yml");
const nginx = read("infrastructure/aliyun/nginx-uat.conf");
const deploy = read("infrastructure/aliyun/deploy.sh");
const rollback = read("infrastructure/aliyun/rollback.sh");
const guide = read("docs/deployment/topology-scm-v2-uat-runbook.md");
const rootPackage = JSON.parse(read("package.json"));
const apiPackage = JSON.parse(read("apps/api/package.json"));
const webPackage = JSON.parse(read("apps/web/package.json"));
const workspace = read("pnpm-workspace.yaml");
const lockfile = read("pnpm-lock.yaml");
const sheetJsTarball = readFileSync(new URL("vendor/xlsx-0.20.3.tgz", root));

function service(name) {
  const lines = compose.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `missing Compose service ${name}`);
  const offset = lines.slice(start + 1).findIndex((line) => /^  [a-zA-Z0-9_-]+:$/u.test(line));
  return lines.slice(start, offset === -1 ? lines.length : start + 1 + offset).join("\n");
}

test("Backend image embeds API and background worker and also owns migration tools", () => {
  assert.match(backendDockerfile, /COPY apps\/worker\/src/u);
  assert.match(backendDockerfile, /pnpm --filter @topology\/worker build/u);
  assert.match(backendDockerfile, /pnpm --filter @topology\/api build/u);
  assert.match(backendDockerfile, /COPY --from=builder \/app\/database \.\/database/u);
  assert.match(backendDockerfile, /COPY --from=builder \/app\/tooling \.\/tooling/u);
  assert.match(backendDockerfile, /^CMD \["node", "apps\/api\/dist\/backend-server\.js"\]$/mu);
  assert.equal(apiPackage.dependencies["@topology/worker"], "workspace:*");
});

test("workspace dependency policy excludes vulnerable XLSX and fast-uri releases", () => {
  assert.equal(rootPackage.dependencies.xlsx, undefined);
  assert.equal(webPackage.dependencies.xlsx, "file:../../vendor/xlsx-0.20.3.tgz");
  assert.equal(apiPackage.dependencies.xlsx, undefined);
  assert.match(workspace, /^  fast-uri@3: 3\.1\.5$/mu);
  assert.doesNotMatch(lockfile, /xlsx@0\.18\.5|fast-uri@3\.1\.4/u);
  assert.equal(
    createHash("sha256").update(sheetJsTarball).digest("hex"),
    "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8",
  );
});

test("Web production image stages vendored SheetJS before install", () => {
  const vendorCopy = webDockerfile.indexOf("COPY vendor/xlsx-0.20.3.tgz ./vendor/xlsx-0.20.3.tgz");
  const install = webDockerfile.indexOf("RUN pnpm install --frozen-lockfile --ignore-scripts");
  assert.ok(vendorCopy >= 0 && vendorCopy < install);
});

test("UAT Compose has two custom images and no standalone Worker or Migrator image", () => {
  for (const name of ["migrator", "bootstrap", "stub", "backend", "app", "nginx"]) service(name);
  assert.doesNotMatch(compose, /^  (?:api|worker|preflight):$/mu);
  assert.match(service("app"), /image: "\$\{WEB_IMAGE:/u);
  for (const name of ["migrator", "bootstrap", "stub", "backend"]) {
    assert.match(service(name), /image: "\$\{BACKEND_IMAGE:/u);
  }
  assert.match(service("migrator"), /node_modules\/drizzle-kit\/bin\.cjs.+migrate/u);
  assert.match(service("backend"), /backend-server\.js|image:/u);
  assert.doesNotMatch(compose, /worker\.Dockerfile|topology-scm-worker-|topology-scm-migrator-/u);
});

test("only Nginx publishes a loopback HTTP port and source stays read-only", () => {
  assert.match(service("nginx"), /127\.0\.0\.1:\$\{HTTP_PORT:-18080\}:80/u);
  for (const name of ["app", "backend", "stub"]) assert.doesNotMatch(service(name), /^    ports:/mu);
  assert.match(service("app"), /\/source:\/workspace\/source:ro/u);
  assert.match(service("backend"), /\/source:\/workspace\/source:ro/u);
  assert.match(service("backend"), /\/data\/files:\/var\/lib\/topology-files/u);
  for (const name of ["migrator", "bootstrap", "stub", "backend", "app", "nginx"]) {
    assert.match(service(name), /user: "0:0"/u);
  }
});

test("UAT Nginx owns API routing and clears identity assertions", () => {
  assert.match(nginx, /location \^~ \/api\/v1\//u);
  assert.match(nginx, /proxy_pass http:\/\/backend:3001/u);
  assert.match(nginx, /proxy_pass http:\/\/app:3000/u);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto http/u);
  assert.match(nginx, /proxy_set_header oai-authenticated-user-email ""/u);
  assert.doesNotMatch(nginx, /listen 443|ssl_certificate/u);
});

test("normalized UAT Compose keeps one-shot migration credentials bounded", () => {
  const result = spawnSync("docker", [
    "compose",
    "--env-file", fileURLToPath(new URL("infrastructure/aliyun/.env.production.template", root)),
    "--profile", "tools",
    "-f", fileURLToPath(new URL("infrastructure/aliyun/docker-compose.yml", root)),
    "config", "--format", "json",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(normalized.services.migrator.environment).sort(), [
    "DATABASE_URL", "DB_SSL", "DB_SSL_REJECT_UNAUTHORIZED",
  ]);
  assert.equal(normalized.services.backend.environment.LOCAL_FIXED_OTP_CODE, "123456");
  assert.equal(normalized.services.backend.environment.WORKER_INTERNAL_URL, undefined);
});

test("deploy pulls images, migrates, bootstraps, starts the stack and never prunes", () => {
  const pull = deploy.indexOf('docker pull "${WEB_IMAGE}"');
  const migrate = deploy.indexOf("--profile tools run --rm migrator");
  const bootstrap = deploy.indexOf("--profile tools run --rm bootstrap");
  const start = deploy.indexOf("up -d --remove-orphans stub backend app nginx");
  const health = deploy.indexOf("/api/v1/health/ready");
  assert.ok(pull >= 0 && pull < migrate && migrate < bootstrap && bootstrap < start && start < health);
  assert.doesNotMatch(deploy, /docker compose build|image prune|systemctl|nginx -t|down -v/u);
});

test("rollback only changes images and never rolls back schema", () => {
  assert.match(rollback, /export WEB_IMAGE="\$1"/u);
  assert.match(rollback, /export BACKEND_IMAGE="\$2"/u);
  assert.match(rollback, /up -d --no-build stub backend app nginx/u);
  assert.doesNotMatch(rollback, /db:migrate|drizzle|\.sql|down -v|image prune/iu);
});

test("deployment guide fixes the project root and documents backup and SSH tunnel", () => {
  assert.match(guide, /\/opt\/topology-scm-v2/u);
  assert.match(guide, /RDS `topology_scm` 逻辑备份/u);
  assert.match(guide, /ssh -N -L 18080:127\.0\.0\.1:18080 topology-supply-chain/u);
  assert.match(guide, /验证码固定 `123456`/u);
});
