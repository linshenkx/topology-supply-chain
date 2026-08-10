import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createAliyunBuildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    NODE_ENV: "production",
    APP_ENV: "production",
    DEPLOY_TARGET: "aliyun",
  };
}

export function runAliyunBuild(args = process.argv.slice(2)) {
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next");

  return spawnSync(process.execPath, [nextBin, "build", ...args], {
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
