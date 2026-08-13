import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];
if (!new Set(["dev", "build", "start"]).has(command)) {
  console.error("Usage: node tooling/build/run-vinext.mjs <dev|build|start>");
  process.exit(2);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = resolve(repositoryRoot, "apps/web");
const cli = resolve(webRoot, "node_modules/vinext/dist/cli.js");
const result = spawnSync(process.execPath, [cli, command], {
  cwd: webRoot,
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
