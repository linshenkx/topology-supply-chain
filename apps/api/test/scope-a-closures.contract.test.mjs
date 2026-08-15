import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OPERATIONS_COMMANDS,
  OPERATIONS_COMMAND_RESOURCES,
  productionOrderTransitionSchema,
  purchaseReceiptSchema,
  qualityInspectionSubmitSchema,
} from "../../../packages/contracts/dist/operations-writes.js";

const root = new URL("../../../", import.meta.url);

function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Scope A business closures expose one canonical command and writer resource each", async () => {
  const closures = [
    ["purchase.receive", "purchaseReceiptsPost", "r3.purchase-receipts.commands"],
    ["quality.inspection.submit", "qualityInspectionsPost", "r3.quality-inspections.commands"],
    ["manufacturing.order.transition", "productionOrdersPatch", "r3.production-orders.commands"],
  ];
  for (const [command, key, resource] of closures) {
    assert.equal(OPERATIONS_COMMANDS[key], command, command);
    assert.equal(OPERATIONS_COMMAND_RESOURCES[command], resource, command);
  }
});

test("purchase receipt contract requires full-batch identity and only optional quantities", () => {
  assert.deepEqual(new Set(purchaseReceiptSchema.required), new Set(["purchaseOrderId", "orderItemId", "warehouseId"]));
  assert.ok(purchaseReceiptSchema.properties.receivedQuantity);
  assert.equal(purchaseReceiptSchema.properties.receivedQuantity.type, "integer");
  assert.equal(purchaseReceiptSchema.properties.receivedQuantity.minimum, 1);
  assert.equal(purchaseReceiptSchema.additionalProperties, false);
});

test("whole-batch quality inspection accepts exactly one target and full-batch quantities", async () => {
  assert.ok(qualityInspectionSubmitSchema.properties.batchId);
  assert.ok(qualityInspectionSubmitSchema.properties.executionOrderId);
  assert.equal(qualityInspectionSubmitSchema.required.includes("batchId"), false);
  assert.equal(qualityInspectionSubmitSchema.required.includes("executionOrderId"), false);
  assert.deepEqual(qualityInspectionSubmitSchema.properties.stage.enum.sort(), ["finished_goods", "incoming"].sort());
  const writes = await source("apps/api/src/modules/quality-inspections/writes.ts");
  assert.match(writes, /Exactly one of executionOrderId or batchId is required/u);
  assert.match(writes, /Whole-batch inspection must use full inspection/u);
  assert.match(writes, /Whole batch must be entirely passed or entirely failed/u);
  assert.match(writes, /requestedResult is not supported for whole-batch inspection/u);
  assert.match(writes, /Receipt batch must be inspected as incoming/u);
  assert.match(writes, /Production completion batch must be inspected as finished goods/u);
  assert.match(writes, /Inventory batch has ambiguous or missing inspection provenance/u);
});

test("production materials and release_materials stay in the Scope A command boundary", async () => {
  const actionSchema = productionOrderTransitionSchema.properties.action;
  assert.deepEqual(actionSchema.enum.sort(), ["complete", "materials", "release_materials", "start"].sort());
  const writes = await source("apps/api/src/modules/production-orders/writes.ts");
  assert.ok(writes.includes("consumeReservedInventory(command, reservations, deltaConsumed + deltaLoss)"));
  assert.match(writes, /action === "release_materials"/u);
  assert.match(writes, /Material quantities cannot be decreased/u);
  assert.match(writes, /Issued quantity exceeds real inventory reservations/u);
  assert.match(writes, /No active reservations to release/u);
});

test("frontend routes the three closures through the shared mutation client", async () => {
  const client = await source("apps/web/app/lib/mutation-client.ts");
  assert.ok(client.includes('"/api/v1/purchase-receipts"'));
  assert.ok(client.includes('"/api/v1/purchase-receipts": "purchase.receive"'));
  assert.ok(client.includes('"/api/v1/production-orders": "manufacturing.order.create"'));
  assert.doesNotMatch(client, /apps\/web\/app\/api\/v1/u);
});
