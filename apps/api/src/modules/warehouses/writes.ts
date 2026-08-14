import { randomUUID } from "node:crypto";

import type { DomainRegistrationContext } from "../../platform/registrations.js";
import { PlatformError } from "../../errors.js";
import type { OperationsCommandContext } from "../../platform/operations-command.js";
import {
  audit,
  bumpVersion,
  domainEvent,
  integer,
  jsonObject,
  lockVersion,
  oneOf,
  optionalInteger,
  optionalString,
  requireRole,
  string,
  type Row,
} from "../../platform/operations-support.js";


export async function warehouseCommand(
  context: DomainRegistrationContext,
  command: OperationsCommandContext,
  raw: unknown,
): Promise<Record<string, unknown>> {
  requireRole(command.access, ["admin", "supply_chain"]);
  const body = jsonObject(raw);
  const action = oneOf(body.action, ["create", "request_merge", "deactivate"] as const, "action");
  if (action === "create") {
    const code = string(body.code, "code", 191).toUpperCase();
    const name = string(body.name, "name");
    const type = oneOf(body.type, ["factory", "company", "other"] as const, "type");
    const factoryId = optionalInteger(body.factoryId, "factoryId");
    if (type === "factory" && factoryId === null) throw new PlatformError(400, "BAD_REQUEST", "Factory warehouse requires a factory binding");
    const inserted = await command.transaction.execute(
      `INSERT INTO warehouses (code, name, type, factory_id, address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [code, name, type, factoryId, optionalString(body.address)],
    );
    const id = inserted.insertId!;
    await lockVersion(command.transaction, "warehouse", id);
    await audit(command.transaction, command.access, command.request, {
      action: "create", module: "warehouse_master", entityType: "warehouse", entityId: id,
      businessNo: code, after: { code, name, type, factoryId },
    });
    await domainEvent(context, command.transaction, { type: "WarehouseCreated", aggregateType: "warehouse", aggregateId: id });
    return { warehouse: { id, code, name, type, factoryId, status: "active", version: 1 } };
  }
  const id = integer(body.id, "id");
  const rows = await command.transaction.query<Row>(
    `SELECT id, code, name, type, factory_id AS factoryId, status FROM warehouses WHERE id = ? LIMIT 1 FOR UPDATE`, [id],
  );
  const warehouse = rows[0];
  if (warehouse === undefined) throw new PlatformError(404, "NOT_FOUND", "Warehouse not found");
  const version = await lockVersion(command.transaction, "warehouse", id);
  if (warehouse.status !== "active") throw new PlatformError(409, "CONFLICT", "Warehouse is not active");
  if (action === "request_merge") {
    const targetId = integer(body.targetId, "targetId");
    const reason = string(body.reason, "reason");
    if (targetId === id) throw new PlatformError(400, "BAD_REQUEST", "Merge target must differ");
    const targets = await command.transaction.query<Row>(
      `SELECT id, name, status FROM warehouses WHERE id = ? LIMIT 1 FOR UPDATE`, [targetId],
    );
    if (targets[0] === undefined) throw new PlatformError(404, "NOT_FOUND", "Target warehouse not found");
    if (targets[0].status !== "active") throw new PlatformError(409, "CONFLICT", "Target warehouse is not active");
    const approvalNo = `AP-WHM-${randomUUID()}`;
    const approval = await command.transaction.execute(
      `INSERT INTO approval_requests (
         request_no, workflow_type, entity_type, entity_id, summary, payload_json,
         high_risk, status, requested_by, requested_at, created_at, updated_at
       ) VALUES (?, 'warehouse_merge', 'warehouse', ?, ?, ?, 0, 'pending', ?,
                 CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
      [approvalNo, id, `Warehouse merge ${warehouse.name} -> ${targets[0].name}`, JSON.stringify({ sourceId: id, targetId, reason }), command.access.userId],
    );
    await audit(command.transaction, command.access, command.request, {
      action: "submit_approval", module: "warehouse_master", entityType: "warehouse_merge", entityId: approval.insertId!,
      businessNo: approvalNo, after: { sourceId: id, targetId, reason },
    });
    await domainEvent(context, command.transaction, {
      type: "ApprovalRequested", aggregateType: "warehouse", aggregateId: id,
      recipient: { kind: "role", role: "supply_chain" },
      deduplicationSuffix: approval.insertId!,
      payload: { approvalId: approval.insertId!, workflowType: "warehouse_merge" },
    });
    return { approval: { id: approval.insertId, requestNo: approvalNo }, approvalRequired: true, version };
  }
  const blockers = await command.transaction.query<Row>(
    `SELECT
       (SELECT COUNT(*) FROM inventory_batches WHERE warehouse_id = ? AND
          (available_quantity + locked_quantity + defective_quantity + pending_inspection_quantity + quarantine_quantity) <> 0) AS inventory,
       (SELECT COUNT(*) FROM inventory_transfers WHERE (from_warehouse_id = ? OR to_warehouse_id = ?)
          AND status IN ('pending_supply_chain','approved','shipped')) AS transfers,
       (SELECT COUNT(*) FROM stocktakes WHERE warehouse_id = ? AND status IN ('first_count','recount','pending_approval')) AS stocktakes`,
    [id, id, id, id],
  );
  const blocker = blockers[0] ?? {};
  if ([blocker.inventory, blocker.transfers, blocker.stocktakes].some((value) => Number(value) > 0)) {
    throw new PlatformError(409, "CONFLICT", "Warehouse has active blockers", { blockers: blocker });
  }
  const updated = await command.transaction.execute(
    `UPDATE warehouses SET status = 'inactive', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'active'`, [id],
  );
  if (updated.affectedRows !== 1) throw new PlatformError(409, "VERSION_CONFLICT", "Warehouse changed concurrently");
  const nextVersion = await bumpVersion(command.transaction, "warehouse", id, version);
  await audit(command.transaction, command.access, command.request, {
    action: "deactivate", module: "warehouse_master", entityType: "warehouse", entityId: id,
    businessNo: String(warehouse.code), before: warehouse, after: { status: "inactive", version: nextVersion },
  });
  await domainEvent(context, command.transaction, { type: "WarehouseDeactivated", aggregateType: "warehouse", aggregateId: id });
  return { success: true, id, status: "inactive", version: nextVersion };
}
