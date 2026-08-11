import type { FastifyInstance } from "fastify";

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseClient,
  type DatabaseEnvironment,
} from "./infrastructure/database.js";
import { createAuditWriter } from "./infrastructure/audit.js";
import { createAuditXlsxExporter } from "./infrastructure/audit-xlsx.js";
import { createOssFileStorage } from "./infrastructure/oss-storage.js";
import { createSupplierPerformanceXlsxExporter } from "./infrastructure/supplier-performance-xlsx.js";
import { registerApprovalsModule } from "./modules/approvals/index.js";
import {
  registerAuditLogsModule,
  type AuditLogExportPort,
} from "./modules/audit-logs/index.js";
import {
  authenticateRequest,
  registerAuthModule,
  type AuthEnvironment,
} from "./modules/auth/index.js";
import { registerFinanceModule } from "./modules/finance/index.js";
import {
  registerFilesModule,
  type FileStoragePort,
} from "./modules/files/index.js";
import { registerImportsModule } from "./modules/imports/index.js";
import { registerInventoryModule } from "./modules/inventory/index.js";
import { registerMasterDataModule } from "./modules/master-data/index.js";
import { registerNotificationsModule } from "./modules/notifications/index.js";
import { registerPurchaseOrdersModule } from "./modules/purchase-orders/index.js";
import { registerPurchasePlansModule } from "./modules/purchase-plans/index.js";
import { registerProductionOrdersModule } from "./modules/production-orders/index.js";
import { registerQualityInspectionsModule } from "./modules/quality-inspections/index.js";
import { registerReturnsModule } from "./modules/returns/index.js";
import { registerShipmentsModule } from "./modules/shipments/index.js";
import { registerStocktakesModule } from "./modules/stocktakes/index.js";
import {
  registerSuppliersModule,
  type SupplierPerformanceExportPort,
} from "./modules/suppliers/index.js";
import { registerUsersModule } from "./modules/users/index.js";
import { registerWarehousesModule } from "./modules/warehouses/index.js";
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
  auditExporter?: AuditLogExportPort;
  environment?: DatabaseEnvironment;
  fileStorage?: FileStoragePort;
  now?: () => Date;
  supplierPerformanceExporter?: SupplierPerformanceExportPort;
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
    const authenticate = (request: Parameters<typeof authenticateRequest>[1]) =>
      authenticateRequest(database, request, authOptions);
    const audit = createAuditWriter({
      ...(database === undefined ? {} : { database }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const auditExporter = options.auditExporter ?? createAuditXlsxExporter();
    const fileStorage =
      options.fileStorage ?? createOssFileStorage({ env: environment });
    const supplierPerformanceExporter =
      options.supplierPerformanceExporter ??
      createSupplierPerformanceXlsxExporter();

    await registerAuthModule(app, authOptions);
    await registerMasterDataModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await registerFinanceModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
    });
    await registerApprovalsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
    });
    await registerInventoryModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
    });
    await registerStocktakesModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerShipmentsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerWarehousesModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerPurchasePlansModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerPurchaseOrdersModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerImportsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerProductionOrdersModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit: (event) => audit(event),
    });
    await registerQualityInspectionsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerReturnsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerSuppliersModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit: (event, actor, request) =>
        audit({
          access: { localPreview: false, userId: actor.userId },
          action: event.action,
          module: event.module,
          entityType: event.entityType,
          entityId: event.entityId,
          exported: event.exported === true,
          sensitiveView: event.sensitiveView,
          request,
          ...(event.count === undefined
            ? {}
            : { after: { count: event.count } }),
        }),
      exportPerformance: supplierPerformanceExporter,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await registerUsersModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await registerAuditLogsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
      exporter: auditExporter,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await registerNotificationsModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
    });
    await registerFilesModule(app, {
      ...(database === undefined ? {} : { database }),
      authenticate,
      audit,
      storage: fileStorage,
    });

    return app;
  } catch (error) {
    await closeAfterFailedStartup(app, database, ownsDatabase);
    throw error;
  }
}
