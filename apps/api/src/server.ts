import type { FastifyInstance } from "fastify";

import { buildRuntimeApp } from "./runtime.js";
import { safeErrorName } from "./safe-logging.js";

const defaultHost = "0.0.0.0";
const defaultPort = 3001;

function readPort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") {
    return defaultPort;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

let app: FastifyInstance | undefined;
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  if (app === undefined) {
    return;
  }
  app.log.info({ signal }, "Graceful shutdown started");

  try {
    await app.close();
    app.log.info("Graceful shutdown completed");
  } catch (error) {
    app.log.error(
      {
        event: "graceful_shutdown_failed",
        errorName: safeErrorName(error),
      },
      "Graceful shutdown failed",
    );
    process.exitCode = 1;
  }
}

try {
  app = await buildRuntimeApp();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
  await app.listen({
    host: process.env.HOST?.trim() || defaultHost,
    port: readPort(process.env.PORT),
  });
} catch (error) {
  if (app !== undefined) {
    app.log.fatal(
      { event: "api_startup_failed", errorName: safeErrorName(error) },
      "API startup failed",
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({
        level: "fatal",
        event: "api_startup_failed",
        errorName: safeErrorName(error),
        message: "API startup failed",
      })}\n`,
    );
  }
  process.exitCode = 1;
  if (app !== undefined) {
    await app.close();
  }
}
