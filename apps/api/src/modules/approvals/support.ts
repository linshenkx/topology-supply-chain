import { createHash } from "node:crypto";

import { PlatformError } from "../../errors.js";
import type { QueryExecutor } from "../../infrastructure/database.js";
import { insertId, requestNo } from "../../platform/supply-support.js";
import type { DomainRegistrationContext } from "../../platform/registrations.js";

export async function createApproval(
  transaction: QueryExecutor,
  input: {
    entityId: number;
    entityType: string;
    highRisk?: boolean;
    idempotencyKey: string;
    payload: unknown;
    requestedBy: number;
    summary: string;
    workflowType: string;
    discriminator?: string;
  },
): Promise<number> {
  const approvalId = await insertId(
    transaction,
    `INSERT INTO approval_requests (
       request_no, workflow_type, entity_type, entity_id, summary, payload_json,
       high_risk, status, requested_by, requested_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [
      requestNo("AP-R2", input.idempotencyKey, input.discriminator ?? input.workflowType),
      input.workflowType,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.payload),
      input.highRisk === true ? 1 : 0,
      input.requestedBy,
    ],
  );
  const version = await transaction.execute(
    `INSERT INTO resource_versions (resource_type, resource_id, version, updated_at)
     VALUES ('approval_request', ?, 1, CURRENT_TIMESTAMP(3))`,
    [String(approvalId)],
  );
  if (version.affectedRows !== 1) throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Approval version write failed");
  return approvalId;
}

export async function approvalNotification(
  context: DomainRegistrationContext,
  transaction: QueryExecutor,
  input: {
    approvalId: number;
    idempotencyKey: string;
    targetEntityId: number | string;
    targetEntityType: string;
    workflowType: string;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.approvalId) || input.approvalId <= 0) {
    throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Approval notification target is invalid");
  }
  await context.enqueueOutbox(transaction, {
    topic: "notification.dispatch",
    aggregateType: "approval_request",
    aggregateId: String(input.approvalId),
    deduplicationKey: `r2:approval:${input.workflowType}:${input.approvalId}:${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`,
    payload: {
      approvalId: input.approvalId,
      recipientRole: "supply_chain",
      type: input.workflowType,
      targetEntityType: input.targetEntityType,
      targetEntityId: String(input.targetEntityId),
    },
  });
}
