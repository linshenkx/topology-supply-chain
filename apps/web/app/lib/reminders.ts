import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@database/index";
import { invoiceExceptions, notificationMessages, reminderSchedules, userRoles, users } from "@database/schema";

export async function createReminder(input: {
  reminderType: string; entityType: string; entityId: number; businessNo?: string;
  dueAt: string; nextRunAt: string; recurrence: "once" | "daily_overdue" | "milestones";
  milestoneDays?: number[]; recipientRoles: string[]; recipientUserIds?: number[];
  severity?: "normal" | "yellow" | "red" | "approval";
}) {
  return getDb().insert(reminderSchedules).values({
    reminderType: input.reminderType, entityType: input.entityType, entityId: input.entityId,
    businessNo: input.businessNo, dueAt: input.dueAt, nextRunAt: input.nextRunAt,
    recurrence: input.recurrence, milestoneDaysJson: JSON.stringify(input.milestoneDays ?? []),
    recipientRoleJson: JSON.stringify(input.recipientRoles), recipientUserIdsJson: JSON.stringify(input.recipientUserIds ?? []),
    severity: input.severity ?? "normal", quietHoursBypass: ["red", "approval"].includes(input.severity ?? ""),
  });
}

export async function processDueReminders(now = new Date()) {
  const db = getDb();
  const due = await db.select().from(reminderSchedules).where(and(
    eq(reminderSchedules.status, "active"),
    lte(reminderSchedules.nextRunAt, now.toISOString()),
  )).limit(500);
  const allUsers = await db.select().from(users);
  const activeRoles = await db.select().from(userRoles).where(eq(userRoles.status, "active"));
  let generated = 0;

  for (const reminder of due) {
    const roles = JSON.parse(reminder.recipientRoleJson) as string[];
    const explicit = new Set(JSON.parse(reminder.recipientUserIdsJson) as number[]);
    const roleUserIds = new Set(activeRoles.filter(row => roles.includes(row.roleCode)).map(row => row.userId));
    const recipients = allUsers.filter(user => explicit.has(user.id) || roles.includes(user.role) || roleUserIds.has(user.id));
    const overdue = now.getTime() > new Date(reminder.dueAt).getTime();
    if (
      reminder.reminderType === "invoice_replacement_overdue" &&
      overdue &&
      now.getTime() - new Date(reminder.dueAt).getTime() >= 30 * 86400000
    ) {
      await db.update(invoiceExceptions).set({
        status: "risk_warning",
        updatedAt: now.toISOString(),
      }).where(and(
        eq(invoiceExceptions.id, reminder.entityId),
        eq(invoiceExceptions.status, "awaiting_remediation"),
      ));
    }
    const title = `${overdue ? "逾期：" : "提醒："}${reminder.businessNo ?? reminder.reminderType}`;
    const message = overdue ? `该事项已超过截止时间，请立即处理。截止：${reminder.dueAt}` : `该事项即将到期，请及时处理。截止：${reminder.dueAt}`;
    for (const user of recipients) {
      for (const channel of ["in_app", "email"] as const) {
        await db.insert(notificationMessages).values({
          recipientUserId: user.id, recipientRole: user.role, channel, type: reminder.reminderType,
          severity: overdue ? "red" : reminder.severity, title, message,
          entityType: reminder.entityType, entityId: reminder.entityId, businessNo: reminder.businessNo,
        });
        generated++;
      }
    }
    const nextRunAt = reminder.recurrence === "daily_overdue"
      ? new Date(now.getTime() + 86400000).toISOString()
      : null;
    await db.update(reminderSchedules).set({
      status: nextRunAt ? "active" : "completed",
      nextRunAt: nextRunAt ?? reminder.nextRunAt,
      lastRunAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(eq(reminderSchedules.id, reminder.id));
  }
  return { processed: due.length, generated };
}
