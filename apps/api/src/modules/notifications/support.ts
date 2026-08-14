import { PlatformError } from "../../errors.js";
import type { QueryExecutor } from "../../infrastructure/database.js";

export async function createReminder(
  transaction: QueryExecutor,
  input: { businessNo: string; dueAt: string; entityId: number; entityType: string; reminderType: string },
): Promise<void> {
  const result = await transaction.execute(
    `INSERT INTO reminder_schedules (
       reminder_type, entity_type, entity_id, business_no, due_at, next_run_at,
       recurrence, milestone_days_json, recipient_role_json, recipient_user_ids_json,
       channels_json, severity, quiet_hours_bypass, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'daily_overdue', '[]', '["factory","supply_chain"]',
               '[]', '["in_app","email"]', 'approval', 0, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
    [input.reminderType, input.entityType, input.entityId, input.businessNo, input.dueAt, input.dueAt],
  );
  if (result.affectedRows !== 1) throw new PlatformError(503, "INTERNAL_SERVER_ERROR", "Reminder write failed");
}
