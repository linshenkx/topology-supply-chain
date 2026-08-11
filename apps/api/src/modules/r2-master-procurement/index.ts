import {
  r2CommandHeadersSchema,
  r2CommandResponseSchema,
  r2JsonCommandBodySchema,
  type R2MutationPath,
} from "@topology/contracts/r2-writes";
import type { FastifyRequest, HTTPMethods } from "fastify";

import { apiErrorSchemaId } from "@topology/contracts";
import { PlatformError } from "../../errors.js";
import type { AccessContext } from "../auth/index.js";
import type {
  DomainRegistrationContext,
  DomainRegistrationManifest,
} from "../../platform/registrations.js";
import { requireCsrf, requireSameOrigin } from "../../platform/security.js";
import { registerR2ApprovalEffects } from "./approvals.js";
import { commitImport, previewImport, stageImport } from "./imports.js";
import {
  writeMasterData,
  writeSupplier,
  writeSupplierPerformance,
  writeSupplierPrice,
  writeSupplierSku,
} from "./master-suppliers.js";
import {
  createPurchaseOrder,
  createPurchasePlan,
  updatePurchaseOrder,
  updatePurchasePlan,
} from "./procurement.js";
import { requireLiveSession } from "./shared.js";

type Handler = (
  context: DomainRegistrationContext,
  request: FastifyRequest,
  access: AccessContext,
  body: unknown,
) => Promise<{ body: unknown; statusCode: number }>;

interface RouteRegistration {
  handler: Handler;
  method: "PATCH" | "POST";
  path: R2MutationPath;
  success: readonly number[];
}

const ROUTES: readonly RouteRegistration[] = [
  { method: "POST", path: "/api/v1/imports/preview", handler: previewImport, success: [200] },
  { method: "POST", path: "/api/v1/imports/stage", handler: stageImport, success: [201] },
  { method: "POST", path: "/api/v1/imports/commit", handler: commitImport, success: [200, 202] },
  { method: "POST", path: "/api/v1/master-data", handler: writeMasterData, success: [201] },
  { method: "POST", path: "/api/v1/suppliers", handler: writeSupplier, success: [201] },
  { method: "POST", path: "/api/v1/supplier-skus", handler: writeSupplierSku, success: [200, 201] },
  { method: "POST", path: "/api/v1/supplier-prices", handler: writeSupplierPrice, success: [201] },
  { method: "POST", path: "/api/v1/supplier-performance", handler: writeSupplierPerformance, success: [200] },
  { method: "POST", path: "/api/v1/purchase-plans", handler: createPurchasePlan, success: [201] },
  { method: "PATCH", path: "/api/v1/purchase-plans", handler: updatePurchasePlan, success: [200] },
  { method: "POST", path: "/api/v1/purchase-orders", handler: createPurchaseOrder, success: [201] },
  { method: "PATCH", path: "/api/v1/purchase-orders", handler: updatePurchaseOrder, success: [200] },
] as const;

async function register(context: DomainRegistrationContext): Promise<void> {
  registerR2ApprovalEffects(context);
  context.app.get<{ Querystring: { sku: string; supplierId: number } }>(
    "/api/v1/supplier-prices/version",
    {
      schema: {
        tags: ["r2-master-procurement"],
        summary: "Read the authoritative supplier-price object version for step-up",
        querystring: {
          type: "object", additionalProperties: false, required: ["supplierId", "sku"],
          properties: { supplierId: { type: "integer", minimum: 1 }, sku: { type: "string", minLength: 1, maxLength: 191 } },
        },
        response: {
          200: { type: "object", additionalProperties: false, required: ["objectId", "objectVersion"], properties: { objectId: { type: "string" }, objectVersion: { type: "integer", minimum: 1 } } },
          "4xx": { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await context.authenticate(request);
      requireLiveSession(access);
      if (context.database === undefined) throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Database unavailable");
      const objectId = `${request.query.supplierId}:${request.query.sku}`;
      const suppliers = await context.database.query<Record<string, unknown> & { managedByFactoryId: number | null; tier: number | null }>(
        "SELECT tier, managed_by_factory_id AS managedByFactoryId FROM suppliers WHERE id = ? LIMIT 1",
        [request.query.supplierId],
      );
      const supplier = suppliers[0];
      if (supplier === undefined) throw new PlatformError(404, "NOT_FOUND", "Supplier not found");
      const internal = access.roles.some((role) => ["admin", "supply_chain"].includes(role));
      const factory = access.roles.includes("factory") && access.factoryId !== null && supplier.managedByFactoryId === access.factoryId;
      if (!internal && !factory) throw new PlatformError(403, "FORBIDDEN", "Supplier price scope rejected");
      const versions = await context.database.query<Record<string, unknown> & { version: number }>(
        "SELECT version FROM resource_versions WHERE resource_type = 'supplier_price' AND resource_id = ? LIMIT 1",
        [objectId],
      );
      return { objectId, objectVersion: versions[0]?.version ?? 1 };
    },
  );
  for (const route of ROUTES) {
    const responses: Record<string, unknown> = {
      "4xx": { $ref: `${apiErrorSchemaId}#` },
      "5xx": { $ref: `${apiErrorSchemaId}#` },
    };
    for (const status of route.success) responses[String(status)] = r2CommandResponseSchema;
    context.app.route({
      method: route.method as HTTPMethods,
      url: route.path,
      schema: {
        tags: ["r2-master-procurement"],
        summary: `R2 command ${route.method} ${route.path}`,
        headers: r2CommandHeadersSchema,
        body: r2JsonCommandBodySchema,
        response: responses,
      },
      handler: async (request, reply) => {
        requireSameOrigin(request);
        requireCsrf(request);
        const access = await context.authenticate(request);
        requireLiveSession(access);
        if (context.database === undefined) {
          throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Database unavailable");
        }
        const response = await route.handler(context, request, access, request.body);
        return reply.status(response.statusCode).send(response.body);
      },
    });
  }
}

const manifest: DomainRegistrationManifest = {
  id: "r2.master-procurement",
  register,
};

export default manifest;
export { register as registerR2MasterProcurement };
