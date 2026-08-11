import type { FastifyInstance } from "fastify";

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseClient,
  type DatabaseEnvironment,
} from "./infrastructure/database.js";
import {
  authenticateRequest,
  registerAuthModule,
  type AuthEnvironment,
} from "./modules/auth/index.js";
import { registerMasterDataModule } from "./modules/master-data/index.js";
import {
  buildApp,
  type BuildAppOptions,
} from "./app.js";

const defaultInjectedDatabasePingTimeoutMs = 2_000;
const readinessTimeoutMarginMs = 250;

export interface BuildRuntimeAppOptions
  extends Pick<
    BuildAppOptions,
    "logger" | "readinessTimeoutMs" | "serviceName"
  > {
  database?: DatabaseClient;
  databaseFactory?: (environment: DatabaseEnvironment) => DatabaseClient;
  databasePingTimeoutMs?: number;
  environment?: DatabaseEnvironment;
  now?: () => Date;
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function isProductionRuntime(environment: DatabaseEnvironment): boolean {
  return (
    normalized(environment.APP_ENV) === "production" ||
    normalized(environment.DEPLOY_TARGET) === "aliyun" ||
    normalized(environment.NODE_ENV) === "production"
  );
}

function hasDatabaseConfiguration(environment: DatabaseEnvironment): boolean {
  return (environment.DATABASE_URL?.trim().length ?? 0) > 0;
}

function authEnvironment(
  environment: DatabaseEnvironment,
): AuthEnvironment {
  return {
    ...(environment.APP_ENV === undefined
      ? {}
      : { appEnv: environment.APP_ENV }),
    ...(environment.DEPLOY_TARGET === undefined
      ? {}
      : { deployTarget: environment.DEPLOY_TARGET }),
    ...(environment.NODE_ENV === undefined
      ? {}
      : { nodeEnv: environment.NODE_ENV }),
  };
}

async function closeAfterFailedStartup(
  app: FastifyInstance | undefined,
  database: DatabaseClient | undefined,
  ownsDatabase: boolean,
): Promise<void> {
  try {
    if (app !== undefined) {
      await app.close();
    } else if (ownsDatabase && database !== undefined) {
      await database.close();
    }
  } catch {
    // Preserve the original startup failure. Runtime logs never serialize secrets.
  }
}

export async function buildRuntimeApp(
  options: BuildRuntimeAppOptions = {},
): Promise<FastifyInstance> {
  const environment = options.environment ?? process.env;
  const production = isProductionRuntime(environment);
  let database = options.database;
  let ownsDatabase = false;
  let databasePingTimeoutMs =
    options.databasePingTimeoutMs ?? defaultInjectedDatabasePingTimeoutMs;

  if (
    database === undefined &&
    (production || hasDatabaseConfiguration(environment))
  ) {
    const config = readDatabaseConfig(environment);
    databasePingTimeoutMs = config.pingTimeoutMs;
    database = (options.databaseFactory ?? ((env) =>
      createDatabaseClient({ env })))(environment);
    ownsDatabase = true;
  }

  const resolvedAuthEnvironment = authEnvironment(environment);
  const readinessTimeoutMs =
    options.readinessTimeoutMs ??
    databasePingTimeoutMs + readinessTimeoutMarginMs;
  let app: FastifyInstance | undefined;

  try {
    app = await buildApp({
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.serviceName === undefined
        ? {}
        : { serviceName: options.serviceName }),
      readinessTimeoutMs,
      readinessChecks:
        database === undefined
          ? []
          : [
              {
                name: "mysql",
                run: () => database?.ping({ timeoutMs: databasePingTimeoutMs }),
              },
            ],
    });

    if (ownsDatabase && database !== undefined) {
      const ownedDatabase = database;
      app.addHook("onClose", async () => {
        await ownedDatabase.close();
      });
    }

    const authOptions = {
      ...(database === undefined ? {} : { database }),
      environment: resolvedAuthEnvironment,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    await registerAuthModule(app, authOptions);
    await registerMasterDataModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate: (request) =>
        authenticateRequest(database, request, authOptions),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    return app;
  } catch (error) {
    await closeAfterFailedStartup(app, database, ownsDatabase);
    throw error;
  }
}
