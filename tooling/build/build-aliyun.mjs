import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = resolve(repositoryRoot, "apps/web");

export function createAliyunBuildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    NODE_ENV: "production",
    APP_ENV: "production",
    DEPLOY_TARGET: "aliyun",
  };
}

export function runAliyunBuild(args = process.argv.slice(2)) {
  const require = createRequire(resolve(webRoot, "package.json"));
  const nextBin = require.resolve("next/dist/bin/next");

  return spawnSync(process.execPath, [nextBin, "build", ...args], {
    cwd: webRoot,
    env: createAliyunBuildEnv(),
    stdio: "inherit",
  });
}

const entryUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (entryUrl === import.meta.url) {
  const result = runAliyunBuild();
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
