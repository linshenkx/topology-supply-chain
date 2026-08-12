import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAliyunBuildEnv } from "../scripts/build-aliyun.mjs";

test("archive, outputs, and generated state are excluded from source and image scans", async () => {
  const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
  const eslintConfig = await readFile("eslint.config.mjs", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.ok(tsconfig.exclude?.includes("outputs"));
  assert.ok(tsconfig.exclude?.includes("archive"));
  assert.match(eslintConfig, /["']outputs\/\*\*["']/);
  assert.match(eslintConfig, /["']archive\/\*\*["']/);
  for (const pattern of ["archive", "outputs", ".tmp", ".pnpm-store", "topology-scm-*.tar.gz", "*.tsbuildinfo"]) {
    assert.ok(dockerignore.split(/\r?\n/u).includes(pattern), `${pattern} must stay outside Docker context`);
  }
});

test("Worker runtime closure does not copy builder workspace or vendor inputs", async () => {
  const workerDockerfile = await readFile("Dockerfile.worker", "utf8");
  const runner = workerDockerfile.split("FROM node:22-alpine AS runner")[1];
  assert.ok(runner);
  assert.doesNotMatch(runner, /COPY[^\n]*(?:vendor|node_modules|packages)/u);
  assert.match(runner, /COPY --from=builder[^\n]*\/prod\/apps\/worker \.\/apps\/worker/u);
});

test("Aliyun builds pin the production runtime without requiring secrets", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const dockerfile = await readFile("Dockerfile.aliyun", "utf8");
  const env = createAliyunBuildEnv({
    APP_ENV: "preview",
    DEPLOY_TARGET: "cloudflare",
    NODE_ENV: "development",
    PRESERVED_VALUE: "yes",
  });

  assert.deepEqual(
    {
      APP_ENV: env.APP_ENV,
      DEPLOY_TARGET: env.DEPLOY_TARGET,
      NODE_ENV: env.NODE_ENV,
      PRESERVED_VALUE: env.PRESERVED_VALUE,
      DATABASE_URL: env.DATABASE_URL,
    },
    {
      APP_ENV: "production",
      DEPLOY_TARGET: "aliyun",
      NODE_ENV: "production",
      PRESERVED_VALUE: "yes",
      DATABASE_URL: undefined,
    },
  );
  assert.equal(
    packageJson.scripts["build:aliyun"],
    "node scripts/build-aliyun.mjs",
  );
  assert.match(dockerfile, /ENV APP_ENV=production/);
  assert.match(dockerfile, /ENV DEPLOY_TARGET=aliyun/);
  assert.match(dockerfile, /RUN pnpm build:aliyun/);
});
