import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAliyunBuildEnv } from "../tooling/build/build-aliyun.mjs";

test("archive, outputs, and generated state are excluded from source and image scans", async () => {
  const tsconfig = JSON.parse(await readFile("apps/web/tsconfig.json", "utf8"));
  const eslintConfig = await readFile("apps/web/eslint.config.mjs", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.ok(tsconfig.exclude?.includes("outputs"));
  assert.ok(tsconfig.exclude?.includes("../../archive"));
  assert.match(eslintConfig, /["']outputs\/\*\*["']/);
  assert.match(eslintConfig, /["']archive\/\*\*["']/);
  for (const pattern of ["archive", "outputs", ".tmp", ".pnpm-store", "topology-scm-*.tar.gz", "*.tsbuildinfo"]) {
    assert.ok(dockerignore.split(/\r?\n/u).includes(pattern), `${pattern} must stay outside Docker context`);
  }
});

test("Sites build tooling has a visible Cloudflare owner outside ignored build output", async () => {
  const gitignore = await readFile(".gitignore", "utf8");
  const viteConfig = await readFile("apps/web/vite.config.ts", "utf8");
  const plugin = await readFile("apps/web/platform/cloudflare/sites-vite-plugin.ts", "utf8");

  assert.match(gitignore, /^\/build\/$/mu);
  assert.match(viteConfig, /\.\/platform\/cloudflare\/sites-vite-plugin/u);
  assert.match(plugin, /name: "sites"/u);
  await assert.rejects(readFile("build/sites-vite-plugin.ts", "utf8"), { code: "ENOENT" });
});

test("Cloudflare Web adapter cannot be confused with the canonical background Worker", async () => {
  const viteConfig = await readFile("apps/web/vite.config.ts", "utf8");
  const adapter = await readFile("apps/web/platform/cloudflare/web-adapter.ts", "utf8");

  assert.match(viteConfig, /main: "\.\/platform\/cloudflare\/web-adapter\.ts"/u);
  assert.match(adapter, /Cloudflare Worker entry point for the vinext-starter template/u);
  await assert.rejects(readFile("worker/index.ts", "utf8"), { code: "ENOENT" });
});

test("Worker runtime closure does not copy builder workspace or vendor inputs", async () => {
  const workerDockerfile = await readFile("infrastructure/docker/worker.Dockerfile", "utf8");
  const runner = workerDockerfile.split("FROM node:22-alpine AS runner")[1];
  assert.ok(runner);
  assert.doesNotMatch(runner, /COPY[^\n]*(?:vendor|node_modules|packages)/u);
  assert.match(runner, /COPY --from=builder[^\n]*\/prod\/apps\/worker \.\/apps\/worker/u);
});

test("Aliyun builds pin the production runtime without requiring secrets", async () => {
  const packageJson = JSON.parse(await readFile("apps/web/package.json", "utf8"));
  const dockerfile = await readFile("infrastructure/docker/web.Dockerfile", "utf8");
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
    packageJson.scripts["build:production"],
    "node ../../tooling/build/build-aliyun.mjs",
  );
  assert.match(dockerfile, /ENV APP_ENV=production/);
  assert.match(dockerfile, /ENV DEPLOY_TARGET=aliyun/);
  assert.match(dockerfile, /RUN pnpm build:aliyun/);
});

test("project-controlled imports remain statically analyzable and XLSX stays off the initial client path", async () => {
  const page = await readFile("apps/web/app/page.tsx", "utf8");
  const runtimeEnv = await readFile("apps/web/app/lib/runtime-env.ts", "utf8");
  const databaseRuntime = await readFile("database/runtime/index.ts", "utf8");

  assert.doesNotMatch(page, /^import[^\n]+from ["']xlsx["']/mu);
  const sizeCheck = page.indexOf("file.size > 20 * 1024 * 1024");
  const extensionCheck = page.indexOf("/\\.(xlsx|xls)$/iu.test(file.name)");
  const lazyImport = page.indexOf('await import("xlsx")');
  const parse = page.indexOf("XLSX.read(await file.arrayBuffer()");
  assert.ok(sizeCheck > 0 && sizeCheck < lazyImport);
  assert.ok(extensionCheck > sizeCheck && extensionCheck < lazyImport);
  assert.ok(lazyImport < parse);

  assert.match(runtimeEnv, /await import\(["']cloudflare:workers["']\)/u);
  assert.match(databaseRuntime, /await import\(["']cloudflare:workers["']\)/u);
  assert.doesNotMatch(runtimeEnv, /import\((?:moduleName|workersModuleName)\)/u);
  assert.doesNotMatch(databaseRuntime, /import\((?:moduleName|workersModuleName)\)/u);
});
