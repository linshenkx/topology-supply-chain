import type { FastifyInstance, FastifyRequest } from "fastify";

import type { DatabaseClient, QueryExecutor } from "../infrastructure/database.js";
import type { AuditWriteEvent } from "../infrastructure/audit.js";
import type { AccessContext } from "../modules/auth/index.js";
import type { FilesModuleOptions } from "../modules/files/index.js";
import type { ApprovalEffectRegistry, ApprovalPolicyRegistry } from "./approvals.js";
import { executeCommand, requireWriterFence } from "./commands.js";
import { enqueueOutbox } from "./outbox.js";

export type FileEntityAuthorizer = NonNullable<FilesModuleOptions["authorizeEntity"]>;
const INTERNAL_FILE_ROLES = new Set(["admin", "company_qc", "finance", "supply_chain"]);
export const PLATFORM_FILE_ENTITY_TYPES = Object.freeze([
  "purchase_order", "delivery_batch", "product_return", "supplier_sku", "import_upload", "legacy_file",
] as const);

export function createPlatformFileEntityAuthorizer(database: DatabaseClient): FileEntityAuthorizer {
  return async ({ access, entityId, entityType }) => {
    if (!/^[1-9]\d*$/u.test(entityId)) return false;
    const internal = access.roles.some((role) => INTERNAL_FILE_ROLES.has(role)) ? 1 : 0;
    const parameters = [entityId, internal, access.factoryId, access.supplierId] as const;
    let query: string;
    switch (entityType) {
      case "import_upload":
        return access.roles.some((role) => role === "admin" || role === "supply_chain") &&
          entityId === String(access.userId);
      case "purchase_order":
        query = `SELECT 1 AS allowed FROM purchase_orders po
          LEFT JOIN order_items oi ON oi.purchase_order_id = po.id
          LEFT JOIN execution_orders eo ON eo.order_item_id = oi.id
          WHERE po.id = ? AND (? = 1 OR eo.factory_id = ? OR oi.supplier_id = ?) LIMIT 1`;
        break;
      case "delivery_batch":
        query = `SELECT 1 AS allowed FROM delivery_batches db
          JOIN execution_orders eo ON eo.id = db.execution_order_id
          JOIN order_items oi ON oi.id = eo.order_item_id
          WHERE db.id = ? AND (? = 1 OR eo.factory_id = ? OR oi.supplier_id = ?) LIMIT 1`;
        break;
      case "product_return":
        query = `SELECT 1 AS allowed FROM product_returns pr
          JOIN delivery_batches db ON db.id = pr.source_delivery_batch_id
          JOIN execution_orders eo ON eo.id = db.execution_order_id
          JOIN order_items oi ON oi.id = eo.order_item_id
          WHERE pr.id = ? AND (? = 1 OR eo.factory_id = ? OR oi.supplier_id = ?) LIMIT 1`;
        break;
      case "supplier_sku":
        query = `SELECT 1 AS allowed FROM supplier_skus ss
          WHERE ss.id = ? AND (? = 1 OR ss.factory_id = ? OR ss.supplier_id = ?) LIMIT 1`;
        break;
      case "legacy_file": {
        const rows = await database.query(
          `SELECT 1 AS allowed FROM file_objects
            WHERE id = ? AND entity_type = 'legacy_file' AND entity_id = CAST(id AS CHAR)
              AND owner_user_id = ? LIMIT 1`,
          [entityId, access.userId],
        );
        return rows[0] !== undefined;
      }
      default:
        return false;
    }
    const rows = await database.query(query, parameters);
    return rows[0] !== undefined;
  };
}

export class FileAuthorizationRegistry {
  readonly #authorizers = new Map<string, FileEntityAuthorizer>();
  register(entityType: string, authorizer: FileEntityAuthorizer): void {
    const key = entityType.trim();
    if (!key || this.#authorizers.has(key)) throw new Error("File authorizer registration rejected");
    this.#authorizers.set(key, authorizer);
  }
  async authorize(input: Parameters<FileEntityAuthorizer>[0]): Promise<boolean> {
    const authorizer = this.#authorizers.get(input.entityType);
    return authorizer === undefined ? false : authorizer(input);
  }
}

export interface DomainRegistrationContext {
  app: FastifyInstance;
  database?: DatabaseClient;
  unitOfWork: <Result>(run: (transaction: QueryExecutor) => Promise<Result>) => Promise<Result>;
  executeCommand: typeof executeCommand;
  requireWriterFence: typeof requireWriterFence;
  authenticate: (request: FastifyRequest) => Promise<AccessContext>;
  authorize: (access: AccessContext, roles: readonly string[]) => boolean;
  audit: (event: AuditWriteEvent) => Promise<void>;
  enqueueOutbox: typeof enqueueOutbox;
  approvalPolicy: ApprovalPolicyRegistry;
  approvalEffects: ApprovalEffectRegistry;
  fileAuthorizations: FileAuthorizationRegistry;
}

export interface DomainRegistrationManifest {
  id: string;
  register(context: DomainRegistrationContext): Promise<void> | void;
}
export type DomainRegistration = DomainRegistrationManifest["register"];
export interface ParallelDomainRegistrations { supply?: DomainRegistration; operations?: DomainRegistration }

export async function registerDomainManifests(
  context: DomainRegistrationContext,
  manifests: readonly DomainRegistrationManifest[],
): Promise<void> {
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(manifest.id) || ids.has(manifest.id)) {
      throw new Error("Domain registration manifest rejected");
    }
    ids.add(manifest.id);
    await manifest.register(context);
  }
}

export async function registerParallelDomainModules(
  context: DomainRegistrationContext,
  registrations: ParallelDomainRegistrations,
): Promise<void> {
  await registerDomainManifests(context, [
    ...(registrations.supply === undefined ? [] : [{ id: "r2.domain", register: registrations.supply }]),
    ...(registrations.operations === undefined ? [] : [{ id: "r3.domain", register: registrations.operations }]),
  ]);
}

export async function loadDomainRegistrationManifests(
  raw: string | undefined,
): Promise<readonly DomainRegistrationManifest[]> {
  const specifiers = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const manifests: DomainRegistrationManifest[] = [];
  for (const specifier of specifiers) {
    const loaded: unknown = await import(specifier);
    const candidate = (loaded as { default?: unknown }).default;
    if (typeof candidate !== "object" || candidate === null ||
        typeof (candidate as { id?: unknown }).id !== "string" ||
        typeof (candidate as { register?: unknown }).register !== "function") {
      throw new Error("Domain registration module must default-export a manifest");
    }
    manifests.push(candidate as DomainRegistrationManifest);
  }
  return manifests;
}
