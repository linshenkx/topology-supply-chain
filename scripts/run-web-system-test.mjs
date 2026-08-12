import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Vinext development server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.status === 200) return;
    } catch {
      // The reserved port is not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Vinext development server did not become ready within 30 seconds");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill();
}

const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [vinextCli, "dev", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    APP_ENV: "development",
    DEPLOY_TARGET: "local",
    HOST: "127.0.0.1",
    PORT: String(port),
    WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await waitForServer(baseUrl, child);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    "tests/rendered-html.test.mjs",
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TEST_BASE_URL: baseUrl },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (/(?:^|\n)\s*# SKIP\b/iu.test(result.stdout ?? "")) {
    throw new Error("Web system suite reported a skipped test");
  }
  process.exitCode = result.status ?? 1;
} finally {
  await stop(child);
}
