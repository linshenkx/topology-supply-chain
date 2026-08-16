import type { FastifyInstance } from "fastify";
import {
  startWorkerRuntime,
  type WorkerRuntime,
} from "@topology/worker";

import { loadDomainRegistrationManifests } from "./platform/registrations.js";
import { buildRuntimeApp } from "./runtime.js";
import { safeErrorName } from "./safe-logging.js";

const defaultHost = "0.0.0.0";
const defaultPort = 3001;
const productionDomainManifests = "../composition/supply-writes-manifest.js,../composition/operations-writes-manifest.js";

function readPort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") return defaultPort;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

let app: FastifyInstance | undefined;
let workerRuntime: WorkerRuntime | undefined;
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  app?.log.info({ signal }, "Backend graceful shutdown started");
  try {
    if (app !== undefined) await app.close();
    else await workerRuntime?.close();
    app?.log.info("Backend graceful shutdown completed");
  } catch (error) {
    app?.log.error(
      { event: "backend_shutdown_failed", errorName: safeErrorName(error) },
      "Backend graceful shutdown failed",
    );
    process.exitCode = 1;
  }
}

try {
  workerRuntime = await startWorkerRuntime({
    onFatal(error) {
      process.exitCode = 1;
      if (app !== undefined) {
        app.log.error(
          { event: "background_worker_failed", errorName: safeErrorName(error) },
          "Background worker failed",
        );
        void shutdown("SIGTERM");
      }
    },
  });
  const manifestSpecifiers = process.env.DOMAIN_REGISTRATION_MODULES ??
    (process.env.APP_ENV === "production" && process.env.DEPLOY_TARGET === "aliyun"
      ? productionDomainManifests
      : undefined);
  app = await buildRuntimeApp({
    fileScannerReady: () => workerRuntime?.checkReady() ??
      Promise.reject(new Error("Background worker is unavailable")),
    registrationManifests: await loadDomainRegistrationManifests(manifestSpecifiers),
  });
  app.addHook("onClose", async () => {
    await workerRuntime?.close();
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  await app.listen({
    host: process.env.HOST?.trim() || defaultHost,
    port: readPort(process.env.PORT),
  });
} catch (error) {
  if (app !== undefined) {
    app.log.fatal(
      { event: "backend_startup_failed", errorName: safeErrorName(error) },
      "Backend startup failed",
    );
  } else {
    process.stderr.write(`${JSON.stringify({
      level: "fatal",
      event: "backend_startup_failed",
      errorName: safeErrorName(error),
      message: "Backend startup failed",
    })}\n`);
  }
  process.exitCode = 1;
  if (app !== undefined) await app.close();
  else await workerRuntime?.close();
}
