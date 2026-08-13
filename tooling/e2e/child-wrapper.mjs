import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const separator = args.indexOf("--");
const runId = value("--run");
const ownerToken = value("--owner-token");
const entry = value("--entry");
if (!/^e2e-[a-z0-9][a-z0-9-]{5,80}$/u.test(runId ?? "") || !/^[a-f0-9]{48}$/u.test(ownerToken ?? "") || !entry || separator < 0) throw new Error("Invalid E2E child ownership marker");

const child = spawn(process.execPath, [entry, ...args.slice(separator + 1)], {
  cwd: process.cwd(), env: process.env, windowsHide: true, stdio: "inherit",
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
