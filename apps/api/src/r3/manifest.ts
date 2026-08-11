import {
  R3_COMMANDS,
  approvalDecisionSchema,
  financeCommandSchema,
  inventoryReservationSchema,
  productionOrderCreateSchema,
  productionOrderTransitionSchema,
  qualityInspectionSubmitSchema,
  r3CommandHeadersSchema,
  r3CommandResponseSchema,
  returnCommandSchema,
  shipmentCommandSchema,
  stocktakeOpenSchema,
  stocktakeTransitionSchema,
  transferRequestSchema,
  transferTransitionSchema,
  warehouseCommandSchema,
} from "@topology/contracts/r3-fulfillment-writes";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DomainRegistrationContext, DomainRegistrationManifest } from "../platform/registrations.js";
import { registerR3ApprovalEffects, decideApproval } from "./approval-handler.js";
import { executeR3Command } from "./command.js";
import { financeCommand } from "./finance-handler.js";
import {
  openStocktake,
  requestTransfer,
  reserveInventory,
  transitionStocktake,
  transitionTransfer,
  warehouseCommand,
} from "./inventory-handlers.js";
import { returnCommand, shipmentCommand } from "./logistics-handlers.js";
import {
  createProductionOrder,
  submitQualityInspection,
  transitionProductionOrder,
} from "./production-handlers.js";

type BodyRequest = FastifyRequest<{ Body: Record<string, unknown> }>;
type Handler = (
  context: DomainRegistrationContext,
  command: Parameters<Parameters<typeof executeR3Command>[0]["run"]>[0],
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
  command: Parameters<typeof executeR3Command>[0]["command"],
  handler: Handler,
  responseStatus: number,
): Promise<void> {
  const outcome = await executeR3Command({
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
    tags: ["r3-writes"],
    headers: r3CommandHeadersSchema,
    body,
    response: {
      200: r3CommandResponseSchema,
      201: r3CommandResponseSchema,
    },
  };
}

async function register(context: DomainRegistrationContext): Promise<void> {
  registerR3ApprovalEffects(context);

  context.app.post("/api/v1/approvals", { schema: schema(approvalDecisionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.approvalsPost, decideApproval, 200));
  context.app.post("/api/v1/inventory", { schema: schema(inventoryReservationSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.inventoryPost, reserveInventory, 201));
  context.app.post("/api/v1/inventory/transfers", { schema: schema(transferRequestSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.transfersPost, requestTransfer, 201));
  context.app.patch("/api/v1/inventory/transfers", { schema: schema(transferTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.transfersPatch, transitionTransfer, 200));
  context.app.post("/api/v1/production-orders", { schema: schema(productionOrderCreateSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.productionOrdersPost, createProductionOrder, 201));
  context.app.patch("/api/v1/production-orders", { schema: schema(productionOrderTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.productionOrdersPatch, transitionProductionOrder, 200));
  context.app.post("/api/v1/quality-inspections", { schema: schema(qualityInspectionSubmitSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.qualityInspectionsPost, submitQualityInspection, 201));
  context.app.post("/api/v1/stocktakes", { schema: schema(stocktakeOpenSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.stocktakesPost, openStocktake, 201));
  context.app.patch("/api/v1/stocktakes", { schema: schema(stocktakeTransitionSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.stocktakesPatch, transitionStocktake, 200));
  context.app.post("/api/v1/shipments", { schema: schema(shipmentCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.shipmentsPost, shipmentCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/returns", { schema: schema(returnCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.returnsPost, returnCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/finance", { schema: schema(financeCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.financePost, financeCommand,
      statusFor((request as BodyRequest).body, 200)));
  context.app.post("/api/v1/warehouses", { schema: schema(warehouseCommandSchema) },
    (request, reply) => route(context, request as BodyRequest, reply, R3_COMMANDS.warehousesPost, warehouseCommand,
      statusFor((request as BodyRequest).body, 200)));
}

const manifest: DomainRegistrationManifest = {
  id: "r3.fulfillment-writes",
  register,
};

export default manifest;
