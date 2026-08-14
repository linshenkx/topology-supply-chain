import {
  OPERATIONS_COMMANDS,
  approvalDecisionSchema,
  financeCommandSchema,
  inventoryReservationSchema,
  productionOrderCreateSchema,
  productionOrderTransitionSchema,
  qualityInspectionSubmitSchema,
  operationsCommandHeadersSchema,
  operationsCommandResponseSchema,
  returnCommandSchema,
  shipmentCommandSchema,
  stocktakeOpenSchema,
  stocktakeTransitionSchema,
  transferRequestSchema,
  transferTransitionSchema,
  warehouseCommandSchema,
} from "@topology/contracts/operations-writes";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DomainRegistrationContext, DomainRegistrationManifest } from "../platform/registrations.js";
import { registerOperationsApprovalEffects, decideApproval } from "../modules/approvals/writes.js";
import { executeOperationsCommand } from "../platform/operations-command.js";
import { financeCommand } from "../modules/finance/writes.js";
import {
  requestTransfer,
  reserveInventory,
  transitionTransfer,
} from "../modules/inventory/writes.js";
import {
  openStocktake,
  transitionStocktake,
} from "../modules/stocktakes/writes.js";
import { warehouseCommand } from "../modules/warehouses/writes.js";
import { shipmentCommand } from "../modules/shipments/writes.js";
import { returnCommand } from "../modules/returns/writes.js";
import {
  createProductionOrder,
  transitionProductionOrder,
} from "../modules/production-orders/writes.js";
import { submitQualityInspection } from "../modules/quality-inspections/writes.js";

type BodyRequest = FastifyRequest<{ Body: Record<string, unknown> }>;
type Handler = (
  context: DomainRegistrationContext,
  command: Parameters<Parameters<typeof executeOperationsCommand>[0]["run"]>[0],
  body: unknown,
) => Promise<Record<string, unknown>>;

function statusFor(body: Record<string, unknown>, defaults: number): number {
  const action = body.action;
  return ["create", "receive", "inspect", "create_invoice", "invalidate_invoice",
    "link_replacement_invoice", "record_refund", "record_payment", "request_record_correction",
    "request_merge"].includes(String(action)) ? 201 : defaults;
}

async function route(
  context: DomainRegistrationContext,
  request: BodyRequest,
  reply: FastifyReply,
  command: Parameters<typeof executeOperationsCommand>[0]["command"],
  handler: Handler,
  responseStatus: number,
): Promise<void> {
  const outcome = await executeOperationsCommand({
    command,
    context,
    payload: request.body as never,
    request,
    responseStatus,
    run: (runContext) => handler(context, runContext, request.body),
  });
  await reply.status(outcome.statusCode).send(outcome.body);
}

function schema(body: object): object {
  return {
    tags: ["operations-writes"],
    headers: operationsCommandHeadersSchema,
    body,
    response: {
      200: operationsCommandResponseSchema,
      201: operationsCommandResponseSchema,
    },
  };
}

async function register(context: DomainRegistrationContext): Promise<void> {
  registerOperationsApprovalEffects(context);

  context.app.post("/api/v1/approvals", { schema: schema(approvalDecisionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.approvalsPost, decideApproval, 200));
  context.app.post("/api/v1/inventory", { schema: schema(inventoryReservationSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.inventoryPost, reserveInventory, 201));
  context.app.post("/api/v1/inventory/transfers", { schema: schema(transferRequestSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.transfersPost, requestTransfer, 201));
  context.app.patch("/api/v1/inventory/transfers", { schema: schema(transferTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.transfersPatch, transitionTransfer, 200));
  context.app.post("/api/v1/production-orders", { schema: schema(productionOrderCreateSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.productionOrdersPost, createProductionOrder, 201));
  context.app.patch("/api/v1/production-orders", { schema: schema(productionOrderTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.productionOrdersPatch, transitionProductionOrder, 200));
  context.app.post("/api/v1/quality-inspections", { schema: schema(qualityInspectionSubmitSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.qualityInspectionsPost, submitQualityInspection, 201));
  context.app.post("/api/v1/stocktakes", { schema: schema(stocktakeOpenSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.stocktakesPost, openStocktake, 201));
  context.app.patch("/api/v1/stocktakes", { schema: schema(stocktakeTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.stocktakesPatch, transitionStocktake, 200));
  context.app.post("/api/v1/shipments", { schema: schema(shipmentCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.shipmentsPost, shipmentCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/returns", { schema: schema(returnCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.returnsPost, returnCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/finance", { schema: schema(financeCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.financePost, financeCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/warehouses", { schema: schema(warehouseCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, OPERATIONS_COMMANDS.warehousesPost, warehouseCommand,
      statusFor((request as BodyRequest).body, 200)));
}

// Composition entry: registers the Scope A operations-side write routes by composing
// the governance, inventory, manufacturing, quality, logistics and finance modules.
// The manifest id below is a frozen registration identity and must not change.
const manifest: DomainRegistrationManifest = {
  id: "r3.fulfillment-writes",
  register,
};

export default manifest;
