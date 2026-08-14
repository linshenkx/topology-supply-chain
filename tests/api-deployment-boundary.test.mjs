import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dockerfile = readFileSync(new URL("../infrastructure/docker/api.Dockerfile", import.meta.url), "utf8");
const workerDockerfile = readFileSync(new URL("../infrastructure/docker/worker.Dockerfile", import.meta.url), "utf8");
const aliyunDockerfile = readFileSync(
  new URL("../infrastructure/docker/web.Dockerfile", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const apiPackage = JSON.parse(
  readFileSync(new URL("../apps/api/package.json", import.meta.url), "utf8"),
);
const webPackage = JSON.parse(
  readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"),
);
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const workspace = readFileSync(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);
const sheetJsTarball = readFileSync(
  new URL("../vendor/xlsx-0.20.3.tgz", import.meta.url),
);
const compose = readFileSync(
  new URL("../infrastructure/aliyun/docker-compose.yml", import.meta.url),
  "utf8",
);
const composePath = fileURLToPath(new URL("../infrastructure/aliyun/docker-compose.yml", import.meta.url));
const nginx = readFileSync(
  new URL("../infrastructure/aliyun/nginx-scm.conf", import.meta.url),
  "utf8",
);
const deployScript = readFileSync(
  new URL("../infrastructure/aliyun/deploy.sh", import.meta.url),
  "utf8",
);
const rollbackScript = readFileSync(
  new URL("../infrastructure/aliyun/rollback.sh", import.meta.url),
  "utf8",
);
const fenceScript = readFileSync(
  new URL("../tooling/release/set-writer-fences.mjs", import.meta.url),
  "utf8",
);
const releaseManifestScript = readFileSync(
  new URL("../tooling/release/release-manifest.mjs", import.meta.url),
  "utf8",
);
const activationScript = readFileSync(
  new URL("../tooling/release/activate-writers.sh", import.meta.url),
  "utf8",
);
const domainMigration = readFileSync(
  new URL("../database/migrations/mysql/0004_scope_a_domain_writes.sql", import.meta.url),
  "utf8",
);
const migrationJournal = readFileSync(
  new URL("../database/migrations/mysql/meta/_journal.json", import.meta.url),
  "utf8",
);
const deploymentReadme = readFileSync(
  new URL("../infrastructure/aliyun/README.md", import.meta.url),
  "utf8",
);

function composeService(name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);

  assert.notEqual(start, -1, `compose service ${name} must exist`);

  const nextServiceOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^  [a-zA-Z0-9_-]+:$/.test(line));
  const end = nextServiceOffset === -1 ? lines.length : start + 1 + nextServiceOffset;

  return lines.slice(start, end).join("\n");
}

function composeMappingKeys(service, mappingName) {
  const lines = service.split("\n");
  const start = lines.findIndex((line) => line === `    ${mappingName}:`);

  assert.notEqual(start, -1, `compose mapping ${mappingName} must exist`);

  const nextKeyOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^    [a-zA-Z0-9_-]+:/.test(line));
  const end = nextKeyOffset === -1 ? lines.length : start + 1 + nextKeyOffset;

  return lines
    .slice(start + 1, end)
    .map((line) => /^      ([a-zA-Z0-9_-]+):/.exec(line)?.[1])
    .filter(Boolean)
    .sort();
}

function nginxLocation(signature) {
  const start = nginx.indexOf(signature);
  assert.notEqual(start, -1, `nginx location ${signature} must exist`);

  const openBrace = nginx.indexOf("{", start);
  let depth = 0;

  for (let index = openBrace; index < nginx.length; index += 1) {
    if (nginx[index] === "{") depth += 1;
    if (nginx[index] === "}") depth -= 1;
    if (depth === 0) return nginx.slice(start, index + 1);
  }

  assert.fail(`nginx location ${signature} is not closed`);
}

function scriptLines(source) {
  return source.split(/\r?\n/).map((line) => line.trim());
}

function commandIndex(source, command) {
  const index = scriptLines(source).indexOf(command);
  assert.notEqual(index, -1, `script command must exist: ${command}`);
  return index;
}

test("API image runs the expected artifact as a non-root process", () => {
  assert.match(dockerfile, /^FROM node:22-alpine AS runner$/m);
  assert.match(dockerfile, /^ENV HOST=0\.0\.0\.0$/m);
  assert.match(dockerfile, /^ENV PORT=3001$/m);
  assert.match(dockerfile, /^ENV HOME=\/tmp$/m);
  assert.match(dockerfile, /^USER api$/m);
  assert.match(dockerfile, /^EXPOSE 3001$/m);
  assert.match(
    dockerfile,
    /HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:3001\/api\/v1\/health\/live/,
  );
  assert.match(dockerfile, /^CMD \["node", "apps\/api\/dist\/server\.js"\]$/m);
});

test("API image deploys only the API production closure", () => {
  assert.match(
    dockerfile,
    /pnpm --filter @topology\/api deploy --prod --no-optional \/prod\/apps\/api/,
  );
  assert.match(
    dockerfile,
    /pnpm install --frozen-lockfile --ignore-scripts --no-optional --prod=false/,
  );
  assert.match(
    dockerfile,
    /COPY --from=builder --chown=api:nodejs \/prod\/apps\/api \.\/apps\/api/,
  );
  assert.doesNotMatch(dockerfile, /COPY --from=builder[^\n]*\/app\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder[^\n]*\/app\/packages/);
});

test("workspace dependency policy excludes vulnerable XLSX and fast-uri releases", () => {
  assert.equal(rootPackage.dependencies.xlsx, undefined);
  assert.equal(webPackage.dependencies.xlsx, "file:../../vendor/xlsx-0.20.3.tgz");
  assert.equal(apiPackage.dependencies.xlsx, undefined);
  assert.match(workspace, /^  fast-uri@3: 3\.1\.5$/m);
  assert.match(workspace, /^  esbuild@0\.18\.20: 0\.25\.0$/m);
  assert.doesNotMatch(lockfile, /xlsx@0\.18\.5|fast-uri@3\.1\.4/u);
  assert.match(lockfile, /xlsx@file:vendor\/xlsx-0\.20\.3\.tgz/u);
  assert.match(lockfile, /fast-uri@3\.1\.5/u);
  assert.equal(
    createHash("sha256").update(sheetJsTarball).digest("hex"),
    "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8",
  );
});

test("Web production image stages the vendored SheetJS tarball before install", () => {
  const vendorCopy = Math.max(
    aliyunDockerfile.indexOf("COPY vendor/xlsx-0.20.3.tgz ./vendor/xlsx-0.20.3.tgz"),
    aliyunDockerfile.indexOf("COPY . ."),
  );
  const install = aliyunDockerfile.indexOf(
    "RUN pnpm install --frozen-lockfile --ignore-scripts",
  );
  assert.notEqual(vendorCopy, -1);
  assert.ok(vendorCopy < install);
});

test("compose publishes Web, API, and Worker on separate loopback-only ports", () => {
  const app = composeService("app");
  const api = composeService("api");
  const worker = composeService("worker");
  const migrator = composeService("migrator");

  assert.match(app, /image: topology-scm:\$\{APP_IMAGE_TAG:-latest\}/);
  assert.match(app, /- "127\.0\.0\.1:3000:3000"/);
  assert.match(api, /dockerfile: infrastructure\/docker\/api\.Dockerfile/);
  assert.match(api, /image: topology-scm-api:\$\{API_IMAGE_TAG:-latest\}/);
  assert.match(api, /target: runner/);
  assert.match(api, /HOST: 0\.0\.0\.0/);
  assert.match(api, /PORT: "3001"/);
  assert.match(api, /- "127\.0\.0\.1:3001:3001"/);
  assert.match(api, /\/api\/v1\/health\/ready/);
  assert.match(worker, /dockerfile: infrastructure\/docker\/worker\.Dockerfile/);
  assert.match(worker, /image: topology-scm-worker:\$\{WORKER_IMAGE_TAG:-latest\}/);
  assert.match(worker, /- "127\.0\.0\.1:3002:3002"/);
  assert.match(worker, /\/health\/ready/);
  assert.match(migrator, /image: topology-scm-migrator:\$\{APP_IMAGE_TAG:-latest\}/);
});

test("Web image and compose service enforce a read-only, least-privilege runtime boundary", () => {
  const app = composeService("app");

  assert.match(aliyunDockerfile, /^USER nextjs$/m);
  assert.doesNotMatch(app, /dockerfile: Dockerfile\.(?:api|worker)/);
  assert.doesNotMatch(app, /^\s+env_file:/m);
  assert.deepEqual(composeMappingKeys(app, "environment"), [
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_TEMPLATE_CODE",
    "API_SESSION_SIGNING_KEY",
    "APP_BASE_URL",
    "APP_ENV",
    "DATABASE_URL",
    "DB_POOL_SIZE",
    "DB_SSL",
    "DB_SSL_REJECT_UNAUTHORIZED",
    "DEPLOY_TARGET",
    "JOB_TOKEN",
    "NODE_ENV",
    "OPENAI_API_KEY",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_BUCKET",
    "OSS_ECS_RAM_ROLE",
    "OSS_INTERNAL_ENDPOINT",
    "OSS_REGION",
    "PORT",
    "SESSION_SECRET",
    "SMS_ECS_RAM_ROLE",
    "SMS_REGION_ID",
    "SMS_WEBHOOK_API_KEY",
    "SMS_WEBHOOK_URL",
  ]);
  for (const workerOnly of [
    "EMAIL_WEBHOOK_API_KEY",
    "EMAIL_WEBHOOK_HEALTH_URL",
    "EMAIL_WEBHOOK_URL",
    "FILE_SCAN_WEBHOOK_API_KEY",
    "FILE_SCAN_WEBHOOK_HEALTH_URL",
    "FILE_SCAN_WEBHOOK_URL",
    "OTP_SEALING_KEYS_JSON",
    "WORKER_DB_POOL_SIZE",
  ]) assert.doesNotMatch(app, new RegExp(`^\\s+${workerOnly}:`, "m"));
  assert.match(app, /security_opt:\n\s+- no-new-privileges:true/);
  assert.match(app, /cap_drop:\n\s+- ALL/);
  assert.match(app, /read_only: true/);
  assert.match(app, /tmpfs:\n\s+- \/tmp:size=128m,mode=1777/);
});

test("normalized Compose config separates production preflight from the migration allowlist", () => {
  const result = spawnSync("docker", [
    "compose",
    "--profile", "migration",
    "-f", composePath,
    "config",
    "--no-env-resolution",
    "--format", "json",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(normalized.services.app.env_file, undefined);
  for (const workerOnly of [
    "EMAIL_WEBHOOK_API_KEY",
    "FILE_SCAN_WEBHOOK_API_KEY",
    "OTP_SEALING_KEYS_JSON",
    "WORKER_DB_POOL_SIZE",
  ]) assert.equal(Object.hasOwn(normalized.services.app.environment, workerOnly), false);
  assert.equal(normalized.services.worker.environment.EMAIL_WEBHOOK_API_KEY, "");
  assert.equal(normalized.services.worker.environment.FILE_SCAN_WEBHOOK_API_KEY, "");
  assert.equal(normalized.services.worker.environment.OTP_SEALING_KEYS_JSON, "");
  assert.equal(normalized.services.migrator.env_file, undefined);
  assert.deepEqual(Object.keys(normalized.services.migrator.environment).sort(), [
    "DATABASE_URL", "DB_SSL", "DB_SSL_REJECT_UNAUTHORIZED",
  ]);
  const preflight = composeService("preflight");
  assert.match(preflight, /^    env_file:\n      - \.env\.production$/mu);
  assert.equal((preflight.match(/^    env_file:$/gmu) ?? []).length, 1);
});

test("compose applies a read-only, least-privilege API runtime boundary", () => {
  const api = composeService("api");

  assert.doesNotMatch(api, /^\s+(?:env_file|secrets|extends):/m);
  assert.doesNotMatch(api, /^\s+<<:/m);
  assert.deepEqual(composeMappingKeys(api, "environment"), [
    "API_SESSION_SIGNING_KEY",
    "APP_ENV",
    "DATABASE_URL",
    "DB_CONNECT_TIMEOUT_MS",
    "DB_PING_TIMEOUT_MS",
    "DB_POOL_SIZE",
    "DB_QUERY_TIMEOUT_MS",
    "DB_SSL",
    "DB_SSL_REJECT_UNAUTHORIZED",
    "DB_TRANSACTION_TIMEOUT_MS",
    "DEPLOY_TARGET",
    "DOMAIN_REGISTRATION_MODULES",
    "HOST",
    "NODE_ENV",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_BUCKET",
    "OSS_ECS_RAM_ROLE",
    "OSS_INTERNAL_ENDPOINT",
    "OSS_REGION",
    "OTP_SEALING_KEY",
    "OTP_SEALING_KEY_ID",
    "PORT",
    "WORKER_INTERNAL_URL",
  ]);
  for (const forbiddenEnvironmentKey of [
    "SESSION_SECRET",
    "JOB_TOKEN",
    "SMS_WEBHOOK_URL",
    "SMS_WEBHOOK_API_KEY",
    "SMS_ECS_RAM_ROLE",
    "SMS_REGION_ID",
    "ALIYUN_SMS_SIGN_NAME",
    "ALIYUN_SMS_TEMPLATE_CODE",
    "EMAIL_WEBHOOK_URL",
    "EMAIL_WEBHOOK_API_KEY",
    "EMAIL_WEBHOOK_HEALTH_URL",
    "FILE_SCAN_WEBHOOK_URL",
    "FILE_SCAN_WEBHOOK_API_KEY",
    "FILE_SCAN_WEBHOOK_HEALTH_URL",
    "OPENAI_API_KEY",
  ]) {
    assert.doesNotMatch(
      api,
      new RegExp(`^\\s+${forbiddenEnvironmentKey}:`, "m"),
      `API must not receive ${forbiddenEnvironmentKey}`,
    );
  }
  assert.match(api, /init: true/);
  assert.match(api, /no-new-privileges:true/);
  assert.match(api, /cap_drop:\n\s+- ALL/);
  assert.match(api, /read_only: true/);
  assert.match(api, /tmpfs:\n\s+- \/tmp:size=64m,mode=1777/);
});

test("Worker image and compose service isolate delivery credentials from the API", () => {
  const api = composeService("api");
  const worker = composeService("worker");

  assert.match(workerDockerfile, /^USER worker$/m);
  assert.match(workerDockerfile, /^EXPOSE 3002$/m);
  assert.match(workerDockerfile, /http:\/\/127\.0\.0\.1:3002\/health\/live/);
  assert.match(workerDockerfile, /^CMD \["node", "apps\/worker\/dist\/server\.js"\]$/m);
  for (const key of [
    "SMS_WEBHOOK_URL",
    "SMS_WEBHOOK_API_KEY",
    "EMAIL_WEBHOOK_URL",
    "EMAIL_WEBHOOK_API_KEY",
    "SMS_WEBHOOK_HEALTH_URL",
    "EMAIL_WEBHOOK_HEALTH_URL",
    "FILE_SCAN_WEBHOOK_URL",
    "FILE_SCAN_WEBHOOK_API_KEY",
    "FILE_SCAN_WEBHOOK_HEALTH_URL",
    "OTP_SEALING_KEYS_JSON",
  ]) {
    assert.match(worker, new RegExp(`^\\s+${key}:`, "m"));
    assert.doesNotMatch(api, new RegExp(`^\\s+${key}:`, "m"));
  }
  assert.match(worker, /no-new-privileges:true/);
  assert.match(worker, /cap_drop:\n\s+- ALL/);
  assert.match(worker, /read_only: true/);
});

test("nginx routes only the slash-delimited v1 namespace to the API", () => {
  const apiLocationSignature = "location ^~ /api/v1/ {";
  const apiLocationIndex = nginx.indexOf(apiLocationSignature);
  const legacyLocationIndex = nginx.indexOf("location / {");
  const apiLocation = nginxLocation(apiLocationSignature);
  const legacyLocation = nginxLocation("location / {");

  assert.ok(apiLocationIndex < legacyLocationIndex, "API route must precede the Web fallback");
  assert.match(nginx, /location = \/api\/v1 \{\s+return 308 \/api\/v1\/;/);
  assert.doesNotMatch(nginx, /location \^~ \/api\/v1 \{/);
  assert.match(apiLocation, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.doesNotMatch(apiLocation, /proxy_pass http:\/\/127\.0\.0\.1:3001\/;/);
  assert.match(legacyLocation, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
});

test("nginx forwards correlation and origin metadata but clears identity assertions", () => {
  const apiLocation = nginxLocation("location ^~ /api/v1/ {");

  assert.match(apiLocation, /proxy_set_header X-Request-ID \$request_id;/);
  assert.match(apiLocation, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(apiLocation, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.match(apiLocation, /proxy_set_header X-Forwarded-Host \$host;/);
  assert.match(apiLocation, /proxy_set_header X-Forwarded-Port 443;/);
  assert.match(apiLocation, /proxy_set_header X-Forwarded-Proto https;/);
  assert.match(apiLocation, /proxy_set_header oai-authenticated-user-email "";/);
  assert.match(apiLocation, /proxy_set_header oai-authenticated-user-full-name "";/);
  assert.match(
    apiLocation,
    /proxy_set_header oai-authenticated-user-full-name-encoding "";/,
  );
});

test("deploy uses one release tag for the Web, API, Worker, and migrator images", () => {
  assert.match(
    deployScript,
    /export COMPOSE_ENV_FILES="\$\{DEPLOY_DIR\}\/\.env\.production"/,
  );
  assert.match(deployScript, /export RELEASE_TAG=/);
  assert.match(deployScript, /export APP_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(deployScript, /export API_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(deployScript, /export WORKER_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(deployScript, /docker compose build app api worker migrator/);
});

test("deploy keeps migration ordering and starts all runtime services", () => {
  const build = commandIndex(deployScript, "docker compose build app api worker migrator");
  const envCheck = commandIndex(
    deployScript,
    "docker compose --profile migration run --rm preflight",
  );
  const history = commandIndex(deployScript, "docker compose --profile migration run --rm migrator node tooling/release/check-mysql-migration-history.mjs");
  const stop = commandIndex(deployScript, "docker compose stop app api worker");
  const drain = commandIndex(deployScript, "docker compose --profile migration run --rm migrator node tooling/release/check-write-drain.mjs");
  const migration = commandIndex(deployScript, "docker compose --profile migration run --rm migrator");
  const start = commandIndex(deployScript, "docker compose up -d app api worker");
  const webHealth = commandIndex(
    deployScript,
    'if ! wait_for_service_health "Web" "app" "http://127.0.0.1:3000/api/health"; then',
  );
  const apiHealth = commandIndex(
    deployScript,
    'if ! wait_for_service_health "API" "api" "http://127.0.0.1:3001/api/v1/health/ready"; then',
  );
  const workerHealth = commandIndex(
    deployScript,
    'if ! wait_for_service_health "Worker" "worker" "http://127.0.0.1:3002/health/ready"; then',
  );

  assert.ok(build < envCheck, "all release images must be built before validation");
  assert.ok(envCheck < history && history < stop, "history must fail closed before stopping writers");
  assert.ok(stop < drain && drain < migration, "old writers must stop and drain before migration");
  assert.ok(migration < start, "runtime services must start after append-only migration");
  assert.ok(start < webHealth, "Web readiness must run after both services are switched");
  assert.ok(webHealth < apiHealth, "both readiness gates must run in a deterministic order");
  assert.ok(apiHealth < workerHealth, "Worker readiness must follow API readiness");
  assert.match(deployScript, /printf '%s\\n' "\$\{RELEASE_TAG\}" > \.active-release/);
  assert.doesNotMatch(deployScript, /set-writer-fences|WRITER_ACTIVATION/u);
  assert.doesNotMatch(deployScript, /rollback.*(?:schema|migrat)|(?:schema|migrat).*rollback/i);
});

test("production API loads both Scope A manifests and release metadata covers every domain fence", () => {
  assert.match(compose, /DOMAIN_REGISTRATION_MODULES:[^\n]*r2-master-procurement\/index\.js,[^\n]*r3\/manifest\.js/u);
  assert.match(releaseManifestScript, /r2\.imports\.preview/u);
  assert.match(releaseManifestScript, /r2\.purchase-orders\.update/u);
  assert.match(releaseManifestScript, /r3\.approvals\.commands/u);
  assert.match(releaseManifestScript, /r3\.warehouses\.commands/u);
  assert.match(fenceScript, /WRITER_ACTIVATION_RESOURCES/u);
  assert.match(activationScript, /WRITER_ACTIVATION_EVIDENCE_SHA256/u);
  assert.match(domainMigration, /r2\.imports\.preview/u);
  assert.match(domainMigration, /r3\.warehouses\.commands/u);
  assert.match(migrationJournal, /0004_scope_a_domain_writes/u);
});

test("deploy has bounded, independent Web, API, and Worker readiness gates", () => {
  assert.match(deployScript, /for attempt in \{1\.\.30\}; do/);
  assert.match(
    deployScript,
    /curl -fsS --connect-timeout 2 --max-time 5 "\$\{health_url\}"/,
  );
  assert.match(
    deployScript,
    /if ! wait_for_service_health "Web" "app" "http:\/\/127\.0\.0\.1:3000\/api\/health"; then\s+exit 1\s+fi/,
  );
  assert.match(
    deployScript,
    /if ! wait_for_service_health "API" "api" "http:\/\/127\.0\.0\.1:3001\/api\/v1\/health\/ready"; then\s+exit 1\s+fi/,
  );
  assert.match(
    deployScript,
    /if ! wait_for_service_health "Worker" "worker" "http:\/\/127\.0\.0\.1:3002\/health\/ready"; then\s+exit 1\s+fi/,
  );
  assert.equal((deployScript.match(/if ! wait_for_service_health/g) ?? []).length, 3);
});

test("rollback switches all runtime images to one target tag without touching schema", () => {
  assert.match(
    rollbackScript,
    /export COMPOSE_ENV_FILES="\$\{DEPLOY_DIR\}\/\.env\.production"/,
  );
  assert.match(rollbackScript, /export RELEASE_TAG="\$1"/);
  assert.match(rollbackScript, /export APP_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(rollbackScript, /export API_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(rollbackScript, /export WORKER_IMAGE_TAG="\$\{RELEASE_TAG\}"/);
  assert.match(rollbackScript, /docker image inspect "topology-scm:\$\{APP_IMAGE_TAG\}"/);
  assert.match(
    rollbackScript,
    /docker image inspect "topology-scm-api:\$\{API_IMAGE_TAG\}"/,
  );
  assert.match(
    rollbackScript,
    /docker image inspect "topology-scm-worker:\$\{WORKER_IMAGE_TAG\}"/,
  );
  assert.match(rollbackScript, /ROLLBACK_SERVICES=\(app api worker\)/);
  assert.doesNotMatch(rollbackScript, /ROLLBACK_SERVICES=\(app api\)/);
  assert.match(rollbackScript, /check-release-compatibility\.mjs/);
  assert.match(rollbackScript, /check-legacy-rollback-safety\.mjs/);
  assert.match(rollbackScript, /cat \.active-release/);
  assert.match(rollbackScript, /docker compose up -d --no-build "\$\{ROLLBACK_SERVICES\[@\]\}"/);
  assert.match(
    rollbackScript,
    /if ! wait_for_service_health "Web" "app" "http:\/\/127\.0\.0\.1:3000\/api\/health"; then\s+exit 1\s+fi/,
  );
  assert.match(
    rollbackScript,
    /if ! wait_for_service_health "API" "api" "http:\/\/127\.0\.0\.1:3001\/api\/v1\/health\/ready"; then\s+exit 1\s+fi/,
  );
  assert.match(
    rollbackScript,
    /if ! wait_for_service_health "Worker" "worker" "http:\/\/127\.0\.0\.1:3002\/health\/ready"; then\s+exit 1\s+fi/,
  );
  assert.equal((rollbackScript.match(/if ! wait_for_service_health/g) ?? []).length, 3);
  assert.match(
    rollbackScript,
    /curl -fsS --connect-timeout 2 --max-time 5 "\$\{health_url\}"/,
  );
  assert.doesNotMatch(
    rollbackScript,
    /db:migrate|drizzle-kit|\.sql|schema/i,
  );

  const webImage = commandIndex(
    rollbackScript,
    'if ! docker image inspect "topology-scm:${APP_IMAGE_TAG}" >/dev/null 2>&1; then',
  );
  const apiImage = commandIndex(
    rollbackScript,
    'if ! docker image inspect "topology-scm-api:${API_IMAGE_TAG}" >/dev/null 2>&1; then',
  );
  const workerImage = commandIndex(
    rollbackScript,
    'if ! docker image inspect "topology-scm-worker:${WORKER_IMAGE_TAG}" >/dev/null 2>&1; then',
  );
  const start = commandIndex(rollbackScript, 'docker compose up -d --no-build "${ROLLBACK_SERVICES[@]}"');
  const webHealth = commandIndex(
    rollbackScript,
    'if ! wait_for_service_health "Web" "app" "http://127.0.0.1:3000/api/health"; then',
  );
  const apiHealth = commandIndex(
    rollbackScript,
    'if ! wait_for_service_health "API" "api" "http://127.0.0.1:3001/api/v1/health/ready"; then',
  );
  const workerHealth = commandIndex(
    rollbackScript,
    'if ! wait_for_service_health "Worker" "worker" "http://127.0.0.1:3002/health/ready"; then',
  );

  assert.ok(webImage < apiImage && apiImage < workerImage, "all target images must be checked before switching");
  assert.ok(workerImage < start, "all runtime images and manifest gates must pass before switching");
  assert.ok(start < webHealth, "rollback readiness must run after both services switch");
  assert.ok(webHealth < apiHealth, "rollback must check both services deterministically");
  assert.ok(apiHealth < workerHealth, "rollback must check Worker after API");
});

test("deployment guide documents loopback-only Web, API, and Worker listeners", () => {
  assert.match(deploymentReadme, /Web只监听`127\.0\.0\.1:3000`/);
  assert.match(deploymentReadme, /API只监听`127\.0\.0\.1:3001`/);
  assert.match(deploymentReadme, /Worker健康端口只监听`127\.0\.0\.1:3002`/);
  assert.match(deploymentReadme, /只有Web与API通过Nginx/);
  assert.match(deploymentReadme, /sudo nginx -t/);
  assert.match(deploymentReadme, /sudo systemctl reload nginx/);
  assert.match(
    deploymentReadme,
    /https:\/\/scm\.topologygz\.com\/api\/v1\/health\/ready/,
  );
});
