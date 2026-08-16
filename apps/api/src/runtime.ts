import type { FastifyInstance } from "fastify";

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseClient,
  type DatabaseEnvironment,
} from "./infrastructure/database.js";
import { createAuditWriter } from "./infrastructure/audit.js";
import { createAuditXlsxExporter } from "./infrastructure/audit-xlsx.js";
import { createLocalFileStorage } from "./infrastructure/local-file-storage.js";
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
import { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "./platform/approvals.js";
import { readOtpSealingConfig } from "./platform/secrets.js";
import {
  FileAuthorizationRegistry,
  PLATFORM_FILE_ENTITY_TYPES,
  createPlatformFileEntityAuthorizer,
  registerDomainManifests,
  registerParallelDomainModules,
  type DomainRegistrationManifest,
  type ParallelDomainRegistrations,
} from "./platform/registrations.js";
import { executeCommand, requireWriterFence } from "./platform/commands.js";
import { enqueueOutbox } from "./platform/outbox.js";
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
  fileScannerReady?: () => Promise<void>;
  now?: () => Date;
  supplierPerformanceExporter?: SupplierPerformanceExportPort;
  domainRegistrations?: ParallelDomainRegistrations;
  registrationManifests?: readonly DomainRegistrationManifest[];
  approvalEffects?: ApprovalEffectRegistry;
  approvalPolicy?: ApprovalPolicyRegistry;
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

function createRuntimeFileStorage(environment: DatabaseEnvironment): FileStoragePort {
  const localRoot = environment.LOCAL_FILE_STORAGE_ROOT?.trim();
  const localRuntime =
    normalized(environment.APP_ENV) === "local" &&
    normalized(environment.DEPLOY_TARGET) === "local" &&
    normalized(environment.NODE_ENV) !== "production";
  if (localRoot !== undefined && localRoot.length > 0) {
    if (!localRuntime) {
      throw new Error("Local file storage is restricted to the explicit local runtime");
    }
    return createLocalFileStorage({ root: localRoot });
  }
  if (localRuntime) {
    throw new Error("LOCAL_FILE_STORAGE_ROOT is required for the local runtime");
  }
  return createOssFileStorage({ env: environment });
}

function authEnvironment(
  environment: DatabaseEnvironment,
  cookieSecure: boolean,
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
    cookieSecure,
  };
}

function isLoopbackHost(value: string | undefined): boolean {
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(value?.trim().toLowerCase() ?? "");
}

function isLocalContainerRuntime(environment: DatabaseEnvironment): boolean {
  return normalized(environment.APP_ENV) === "local" &&
    normalized(environment.DEPLOY_TARGET) === "local" &&
    normalized(environment.NODE_ENV) !== "production" &&
    normalized(environment.HOST) === "0.0.0.0";
}

export function resolveCookieSecure(environment: DatabaseEnvironment): boolean {
  const raw = environment.ALLOW_INSECURE_LOCAL_COOKIES?.trim().toLowerCase();
  if (raw !== undefined && raw !== "true" && raw !== "false") {
    throw new Error("ALLOW_INSECURE_LOCAL_COOKIES must be true or false");
  }
  if (raw !== "true") return true;
  if (
    isProductionRuntime(environment) ||
    (!isLoopbackHost(environment.HOST) && !isLocalContainerRuntime(environment))
  ) {
    throw new Error("ALLOW_INSECURE_LOCAL_COOKIES requires a non-production loopback or explicit local container runtime");
  }
  return false;
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
  const cookieSecure = resolveCookieSecure(environment);
  const sessionSigningKey = environment.API_SESSION_SIGNING_KEY?.trim();
  if (production && (sessionSigningKey?.length ?? 0) < 32) {
    throw new Error("API_SESSION_SIGNING_KEY must contain at least 32 characters");
  }
  let otpSealing: ReturnType<typeof readOtpSealingConfig> | undefined;
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
  if (production || cookieSecure === false) {
    otpSealing = readOtpSealingConfig(environment);
  }
  const workerInternalUrl = environment.WORKER_INTERNAL_URL?.trim();
  if (production && !workerInternalUrl && options.fileScannerReady === undefined) {
    throw new Error("WORKER_INTERNAL_URL is required in production");
  }
  const providerReadiness = options.fileScannerReady ?? (async () => {
    if (!workerInternalUrl) throw new Error("WORKER_INTERNAL_URL is required");
    const response = await fetch(new URL("/health/ready", workerInternalUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Worker providers unavailable");
  });

  const resolvedAuthEnvironment = authEnvironment(environment, cookieSecure);
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
      readinessChecks: [
        ...(database === undefined ? [] : [{
          name: "mysql",
          run: () => database?.ping({ timeoutMs: databasePingTimeoutMs }),
        }]),
        ...(!production ? [] : [{
          name: "worker-providers",
          run: providerReadiness,
        }]),
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
      ...(sessionSigningKey === undefined ? {} : { sessionSigningKey }),
      ...(otpSealing === undefined ? {} : { otpSealing }),
    };
    const authenticate = (request: Parameters<typeof authenticateRequest>[1]) =>
      authenticateRequest(database, request, authOptions);
    const audit = createAuditWriter({
      ...(database === undefined ? {} : { database }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const auditExporter = options.auditExporter ?? createAuditXlsxExporter();
    const fileStorage =
      options.fileStorage ?? createRuntimeFileStorage(environment);
    const supplierPerformanceExporter =
      options.supplierPerformanceExporter ??
      createSupplierPerformanceXlsxExporter();
    const fileAuthorizations = new FileAuthorizationRegistry();
    const approvalEffects = options.approvalEffects ?? new ApprovalEffectRegistry();
    const approvalPolicy = options.approvalPolicy ?? new ApprovalPolicyRegistry();
    if (database !== undefined) {
      const builtInFileAuthorization = createPlatformFileEntityAuthorizer(database);
      for (const entityType of PLATFORM_FILE_ENTITY_TYPES) {
        fileAuthorizations.register(entityType, builtInFileAuthorization);
      }
    }

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
      authorizeEntity: (input) => fileAuthorizations.authorize(input),
      scannerReady: providerReadiness,
    });
    const registrationContext = {
      app,
      ...(database === undefined ? {} : { database }),
      unitOfWork: async <Result>(
        run: (transaction: import("./infrastructure/database.js").QueryExecutor) => Promise<Result>,
      ): Promise<Result> => {
        if (database === undefined) throw new Error("Database unavailable");
        return database.transaction(run);
      },
      executeCommand,
      requireWriterFence,
      authenticate,
      authorize: (access: import("./modules/auth/index.js").AccessContext, roles: readonly string[]) =>
        access.roles.some((role) => roles.includes(role)),
      audit,
      enqueueOutbox,
      approvalPolicy,
      approvalEffects,
      fileAuthorizations,
    };
    await registerDomainManifests(
      registrationContext,
      options.registrationManifests ?? [],
    );
    await registerParallelDomainModules(
      registrationContext,
      options.domainRegistrations ?? {},
    );

    return app;
  } catch (error) {
    await closeAfterFailedStartup(app, database, ownsDatabase);
    throw error;
  }
}
