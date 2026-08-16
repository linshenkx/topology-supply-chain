import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const compose = resolve(directory, "docker-compose.yml");
const result = spawnSync("docker", [
  "compose", "-f", compose, "exec", "-T", "stub",
  "wget", "-qO-", "--header=x-local-control-token:local-only-control-token", "http://127.0.0.1:3003/otp",
], { encoding: "utf8", windowsHide: true });

if (result.status !== 0) {
  process.stderr.write(result.stderr || "OTP is not available yet.\n");
  process.exitCode = result.status ?? 1;
} else {
  const payload = JSON.parse(result.stdout);
  process.stdout.write(`${payload.code}\n`);
}
