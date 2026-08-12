import type { JsonValue } from "./commands.js";
import type { QueryExecutor } from "../infrastructure/database.js";

export type OutboxTopic =
  | "email.deliver"
  | "sms.deliver"
  | "reminder.evaluate"
  | "file.scan"
  | "notification.dispatch"
  | "domain.event";

export interface OutboxMessage {
  aggregateId: string;
  aggregateType: string;
  availableAt?: Date;
  deduplicationKey: string;
  maxAttempts?: number;
  payload: JsonValue;
  topic: OutboxTopic;
}

export async function enqueueOutbox(
  transaction: QueryExecutor,
  message: OutboxMessage,
): Promise<void> {
  const availableAt = message.availableAt ?? new Date();
  if (Number.isNaN(availableAt.getTime())) throw new TypeError("Invalid outbox date");
  const result = await transaction.execute(
    `INSERT INTO outbox_messages (
       topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
       status, available_at, attempts, max_attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [
      message.topic,
      message.aggregateType,
      message.aggregateId,
      message.deduplicationKey,
      JSON.stringify(message.payload),
      availableAt.toISOString(),
      message.maxAttempts ?? 8,
    ],
  );
  if (result.affectedRows !== 1) throw new Error("Outbox insert failed");
}
