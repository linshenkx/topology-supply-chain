import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Pool,
  type RowDataPacket,
} from "mysql2/promise";
import {
  checkProviders,
  deliverEmail,
  deliverSms,
  PermanentProviderFailure,
  readWorkerProviders,
  scanFile,
} from "./providers.js";

const workerId = `worker-${randomUUID()}`;
const pollMs = 1_000;
const reminderSweepMs = 60_000;
const leaseMs = 5 * 60_000;
const maxBatch = 25;
const writerGeneration = 2;
const writerOwner = "worker-v1";

interface OutboxRow extends RowDataPacket {
  attempts: number;
  deduplicationKey: string;
  id: number;
  maxAttempts: number;
  payloadJson: string;
  topic: string;
}

interface ReminderRow extends RowDataPacket {
  businessNo: string | null;
  dueAt: string;
  entityId: number;
  entityType: string;
  id: number;
  nextRunAt: string;
  recipientRoleJson: string;
  recipientUserIdsJson: string;
  recurrence: string;
  reminderType: string;
  severity: string;
}

interface UserRow extends RowDataPacket {
  email: string;
  id: number;
  primaryRole: string;
}

async function completeLease(
  connection: mysql.PoolConnection,
  row: OutboxRow,
): Promise<void> {
  const [completed] = await connection.execute<mysql.ResultSetHeader>(
    `UPDATE outbox_messages SET status = 'completed', completed_at = ?,
       locked_by = NULL, locked_at = NULL, last_error_code = NULL,
       updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'processing' AND locked_by = ?`,
    [new Date().toISOString(), row.id, workerId],
  );
  if (completed.affectedRows !== 1) throw new Error("outbox completion lease lost");
}

class PermanentFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PermanentFailure";
    this.code = code;
  }
}

class FencePaused extends Error {
  readonly code = "WRITER_FENCE_PAUSED";
  constructor() {
    super("Writer fence is paused");
    this.name = "FencePaused";
  }
}

async function requireFence(
  connection: mysql.PoolConnection | Pool,
  resource: "files.worker" | "outbox.worker" | "reminders.worker",
): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT owner, enabled, generation FROM writer_fences
     WHERE resource = ? LIMIT 1 FOR SHARE`,
    [resource],
  );
  const row = rows[0];
  if (row?.owner !== writerOwner || Number(row.generation) !== writerGeneration || Number(row.enabled) !== 1) {
    throw new FencePaused();
  }
}

async function requireWorkerFences(connection: Pool): Promise<void> {
  await Promise.all([
    requireFence(connection, "outbox.worker"),
    requireFence(connection, "reminders.worker"),
    requireFence(connection, "files.worker"),
  ]);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databasePool(): Pool {
  const url = new URL(required("DATABASE_URL"));
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must be mysql://");
  return mysql.createPool({
    uri: url.toString(),
    connectionLimit: Number(process.env.WORKER_DB_POOL_SIZE ?? 5),
    dateStrings: true,
    enableKeepAlive: true,
    timezone: "+08:00",
    ...(process.env.DB_SSL === "disabled"
      ? {}
      : { ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } }),
  });
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid payload");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PermanentFailure("INVALID_PAYLOAD");
  }
}

function payloadText(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 10_000) {
    throw new PermanentFailure("INVALID_PAYLOAD");
  }
  return value;
}

async function claim(pool: Pool): Promise<OutboxRow | undefined> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const staleBefore = new Date(Date.now() - leaseMs).toISOString();
    await requireFence(connection, "outbox.worker");
    await connection.execute(
      `UPDATE outbox_messages
       SET status = 'dead', locked_by = NULL, locked_at = NULL,
           last_error_code = 'LEASE_EXHAUSTED', payload_json =
             CASE WHEN topic = 'sms.deliver' THEN '{"redacted":true}' ELSE payload_json END,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE status = 'processing' AND locked_at < ? AND attempts >= max_attempts`,
      [staleBefore],
    );
    const [rows] = await connection.query<OutboxRow[]>(
      `SELECT id, topic, payload_json AS payloadJson,
              deduplication_key AS deduplicationKey,
              attempts, max_attempts AS maxAttempts
       FROM outbox_messages
       WHERE attempts < max_attempts
         AND available_at <= ?
         AND (status = 'pending' OR (status = 'processing' AND locked_at < ?))
       ORDER BY available_at ASC, id ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [new Date().toISOString(), staleBefore],
    );
    const row = rows[0];
    if (row === undefined) {
      await connection.commit();
      return undefined;
    }
    const [result] = await connection.execute<mysql.ResultSetHeader>(
       `UPDATE outbox_messages
       SET status = 'processing', locked_by = ?, locked_at = ?,
           attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [workerId, new Date().toISOString(), row.id],
    );
    if (result.affectedRows !== 1) throw new Error("claim failed");
    await connection.commit();
    return { ...row, attempts: row.attempts + 1 };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function dispatchNotification(
  pool: Pool,
  row: OutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const role = payloadText(payload, "recipientRole");
  const type = payloadText(payload, "type");
  const aggregateId = Number(payload.approvalId);
  if (!Number.isSafeInteger(aggregateId) || aggregateId <= 0) {
    throw new PermanentFailure("INVALID_PAYLOAD");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await requireFence(connection, "outbox.worker");
    const [users] = await connection.query<UserRow[]>(
      `SELECT DISTINCT users.id, users.email, users.role AS primaryRole
       FROM users
       LEFT JOIN user_roles ON user_roles.user_id = users.id
         AND user_roles.status = 'active'
       WHERE users.account_status = 'active'
         AND (users.role = ? OR user_roles.role_code = ?)`,
      [role, role],
    );
    for (const user of users) {
      const emailDeduplicationKey = `notification:${createHash("sha256")
        .update(row.deduplicationKey, "utf8")
        .digest("hex")}:user:${user.id}:email`;
      const [existing] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM outbox_messages
         WHERE deduplication_key = ? LIMIT 1 FOR UPDATE`,
        [emailDeduplicationKey],
      );
      if (existing[0] !== undefined) continue;
      const title = "新的审批待办";
      const message = "有一项高风险变更等待审核。";
      const [inApp] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO notification_messages (
           recipient_user_id, recipient_role, channel, type, severity,
           title, message, entity_type, entity_id, status, sent_at, created_at
         ) VALUES (?, ?, 'in_app', ?, 'approval', ?, ?, 'approval_request', ?,
                   'sent', ?, CURRENT_TIMESTAMP(3))`,
        [user.id, user.primaryRole, type, title, message, aggregateId,
          new Date().toISOString()],
      );
      const [email] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO notification_messages (
           recipient_user_id, recipient_role, channel, type, severity,
           title, message, entity_type, entity_id, status, created_at
         ) VALUES (?, ?, 'email', ?, 'approval', ?, ?, 'approval_request', ?,
                   'queued', CURRENT_TIMESTAMP(3))`,
        [user.id, user.primaryRole, type, title, message, aggregateId],
      );
      await connection.execute(
        `INSERT IGNORE INTO outbox_messages (
           topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
           status, available_at, attempts, max_attempts, created_at, updated_at
        ) VALUES ('email.deliver', 'notification', ?, ?, ?, 'pending', ?, 0, 8,
                   CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [String(email.insertId), emailDeduplicationKey,
          JSON.stringify({ to: user.email, subject: title, text: message, messageId: email.insertId }),
          new Date().toISOString()],
      );
      if (inApp.insertId <= 0) throw new Error("notification insert failed");
    }
    await completeLease(connection, row);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function processMessage(pool: Pool, row: OutboxRow): Promise<boolean> {
  const payload = parsePayload(row.payloadJson);
  switch (row.topic) {
    case "email.deliver":
      await requireFence(pool, "outbox.worker");
      await deliverEmail(providers, row.payloadJson, row.deduplicationKey);
      return false;
    case "sms.deliver":
      await requireFence(pool, "outbox.worker");
      await deliverSms(providers, payload, row.deduplicationKey);
      return false;
    case "notification.dispatch":
      await dispatchNotification(pool, row, payload);
      return true;
    case "file.scan":
      {
        await requireFence(pool, "files.worker");
        const status = await scanFile(providers, row.payloadJson, row.deduplicationKey);
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await requireFence(connection, "files.worker");
          const fileId = Number(payload.fileId);
          if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new PermanentFailure("INVALID_PAYLOAD");
          const [updatedFile] = await connection.execute<mysql.ResultSetHeader>(
            `UPDATE file_objects SET scan_status = ? WHERE id = ?`,
            [status, fileId],
          );
          if (updatedFile.affectedRows !== 1) throw new PermanentFailure("FILE_NOT_FOUND");
          await connection.execute(
            `INSERT INTO audit_logs (actor_user_id, action, module, entity_type, entity_id,
               after_json, sensitive_view, exported, archive_after, created_at)
             VALUES (NULL, 'scan_file', 'files', 'file_object', ?, ?, 0, 0,
               DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 YEAR), CURRENT_TIMESTAMP(3))`,
            [String(fileId), JSON.stringify({ scanStatus: status, backfill: payload.backfill === true })],
          );
          await completeLease(connection, row);
          await connection.commit();
        } catch (error) {
          await connection.rollback().catch(() => undefined);
          throw error;
        } finally {
          connection.release();
        }
      }
      return true;
    default:
      throw new PermanentFailure("UNKNOWN_TOPIC");
  }
}

async function pause(pool: Pool, row: OutboxRow): Promise<void> {
  const [paused] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE outbox_messages
     SET status = 'pending', available_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND),
         attempts = GREATEST(attempts - 1, 0), locked_by = NULL, locked_at = NULL,
         last_error_code = 'WRITER_FENCE_PAUSED', updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'processing' AND locked_by = ?`,
    [row.id, workerId],
  );
  if (paused.affectedRows !== 1) throw new Error("outbox pause lease lost");
}

async function complete(pool: Pool, row: OutboxRow): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await requireFence(connection, "outbox.worker");
    const payload = parsePayload(row.payloadJson);
    const [completed] = await connection.execute<mysql.ResultSetHeader>(
       `UPDATE outbox_messages
       SET status = 'completed', completed_at = ?, locked_by = NULL,
           locked_at = NULL, last_error_code = NULL,
           payload_json = CASE WHEN topic = 'sms.deliver' THEN '{"redacted":true}' ELSE payload_json END,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND status = 'processing' AND locked_by = ?`,
      [new Date().toISOString(), row.id, workerId],
    );
    if (completed.affectedRows !== 1) throw new Error("outbox completion lease lost");
    if (row.topic === "email.deliver" && Number.isSafeInteger(Number(payload.messageId))) {
      await connection.execute(
        `UPDATE notification_messages SET status = 'sent', sent_at = ?, error_message = NULL
         WHERE id = ? AND channel = 'email'`,
        [new Date().toISOString(), Number(payload.messageId)],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function fail(pool: Pool, row: OutboxRow, error: unknown): Promise<void> {
  const permanent = error instanceof PermanentFailure || error instanceof PermanentProviderFailure;
  const dead = permanent || row.attempts >= row.maxAttempts;
  const code = permanent ? error.code : "DELIVERY_FAILED";
  const delaySeconds = Math.min(3_600, 2 ** Math.min(row.attempts, 10) * 5);
  const [failed] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE outbox_messages
     SET status = ?, available_at = ?, locked_by = NULL, locked_at = NULL,
         payload_json = CASE WHEN ? AND topic = 'sms.deliver' THEN '{"redacted":true}' ELSE payload_json END,
         last_error_code = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND status = 'processing' AND locked_by = ?`,
    [dead ? "dead" : "pending",
      new Date(Date.now() + delaySeconds * 1_000).toISOString(), dead, code,
      row.id, workerId],
  );
  if (failed.affectedRows !== 1) throw new Error("outbox failure lease lost");
}

function jsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new PermanentFailure("INVALID_REMINDER");
  }
}

async function sweepReminder(pool: Pool): Promise<boolean> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await requireFence(connection, "reminders.worker");
    const current = new Date();
    const [rows] = await connection.query<ReminderRow[]>(
      `SELECT id, reminder_type AS reminderType, entity_type AS entityType,
              entity_id AS entityId, business_no AS businessNo, due_at AS dueAt,
              next_run_at AS nextRunAt, recurrence, recipient_role_json AS recipientRoleJson,
              recipient_user_ids_json AS recipientUserIdsJson, severity
       FROM reminder_schedules
       WHERE status = 'active' AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [current.toISOString()],
    );
    const reminder = rows[0];
    if (reminder === undefined) {
      await connection.commit();
      return false;
    }
    const roles = jsonArray(reminder.recipientRoleJson).filter((value): value is string => typeof value === "string");
    const explicit = jsonArray(reminder.recipientUserIdsJson).filter((value): value is number => Number.isSafeInteger(value));
    const placeholders = [...roles, ...explicit];
    const conditions: string[] = [];
    if (roles.length > 0) conditions.push(`users.role IN (${roles.map(() => "?").join(",")}) OR user_roles.role_code IN (${roles.map(() => "?").join(",")})`);
    if (explicit.length > 0) conditions.push(`users.id IN (${explicit.map(() => "?").join(",")})`);
    const params = roles.length > 0 ? [...roles, ...roles, ...explicit] : placeholders;
    const [users] = conditions.length === 0
      ? [[] as UserRow[], []]
      : await connection.query<UserRow[]>(
          `SELECT DISTINCT users.id, users.email, users.role AS primaryRole
           FROM users LEFT JOIN user_roles ON user_roles.user_id = users.id
             AND user_roles.status = 'active'
           WHERE users.account_status = 'active' AND (${conditions.join(" OR ")})`,
          params,
        );
    const overdue = current.getTime() > new Date(reminder.dueAt).getTime();
    if (reminder.reminderType === "invoice_replacement_overdue" && overdue &&
        current.getTime() - new Date(reminder.dueAt).getTime() >= 30 * 86_400_000) {
      await connection.execute(
        `UPDATE invoice_exceptions SET status = 'risk_warning',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status = 'awaiting_remediation'`,
        [reminder.entityId],
      );
    }
    const title = `${overdue ? "逾期：" : "提醒："}${reminder.businessNo ?? reminder.reminderType}`;
    const message = overdue
      ? `该事项已超过截止时间，请立即处理。截止：${reminder.dueAt}`
      : `该事项即将到期，请及时处理。截止：${reminder.dueAt}`;
    for (const user of users) {
      await connection.execute(
        `INSERT INTO notification_messages (
           recipient_user_id, recipient_role, channel, type, severity, title,
           message, entity_type, entity_id, business_no, status, sent_at, created_at
         ) VALUES (?, ?, 'in_app', ?, ?, ?, ?, ?, ?, ?, 'sent', ?,
                   CURRENT_TIMESTAMP(3))`,
        [user.id, user.primaryRole, reminder.reminderType,
          overdue ? "red" : reminder.severity, title, message, reminder.entityType,
          reminder.entityId, reminder.businessNo, current.toISOString()],
      );
      const [email] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO notification_messages (
           recipient_user_id, recipient_role, channel, type, severity, title,
           message, entity_type, entity_id, business_no, status, created_at
         ) VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP(3))`,
        [user.id, user.primaryRole, reminder.reminderType,
          overdue ? "red" : reminder.severity, title, message, reminder.entityType,
          reminder.entityId, reminder.businessNo],
      );
      await connection.execute(
        `INSERT INTO outbox_messages (
           topic, aggregate_type, aggregate_id, deduplication_key, payload_json,
           status, available_at, attempts, max_attempts, created_at, updated_at
         ) VALUES ('email.deliver', 'reminder', ?, ?, ?, 'pending', ?, 0, 8,
                   CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`,
        [String(reminder.id), `reminder:${reminder.id}:${reminder.nextRunAt}:user:${user.id}:email`,
          JSON.stringify({ to: user.email, subject: title, text: message,
            businessNo: reminder.businessNo, messageId: email.insertId }),
          current.toISOString()],
      );
    }
    const nextRunAt = reminder.recurrence === "daily_overdue"
      ? new Date(current.getTime() + 86_400_000).toISOString()
      : reminder.nextRunAt;
    await connection.execute(
      `UPDATE reminder_schedules
       SET status = ?, next_run_at = ?, last_run_at = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [reminder.recurrence === "daily_overdue" ? "active" : "completed",
        nextRunAt, current.toISOString(), reminder.id],
    );
    const archive = new Date(current);
    archive.setUTCFullYear(archive.getUTCFullYear() + 5);
    await connection.execute(
      `INSERT INTO audit_logs (
         actor_user_id, action, module, entity_type, entity_id, business_no,
         after_json, sensitive_view, exported, archive_after, created_at
       ) VALUES (NULL, 'process_reminder', 'notifications', 'reminder', ?, ?, ?,
                 0, 0, ?, CURRENT_TIMESTAMP(3))`,
      [String(reminder.id), reminder.businessNo,
        JSON.stringify({ recipients: users.length, nextRunAt, status: reminder.recurrence === "daily_overdue" ? "active" : "completed" }),
        archive.toISOString()],
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

const providers = readWorkerProviders();
const pool = databasePool();
let ready = false;
let stopping = false;
let lastReminderSweep = 0;

const health = createServer(async (request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "topology-worker" }));
    return;
  }
  if (request.url === "/health/ready") {
    try {
      await pool.query("SELECT 1");
      await checkProviders(providers);
      await requireWorkerFences(pool);
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: ready ? "ok" : "not_ready" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "not_ready" }));
    }
    return;
  }
  response.writeHead(404).end();
});

health.listen(Number(process.env.PORT ?? 3002), process.env.HOST ?? "0.0.0.0");

async function loop(): Promise<void> {
  await pool.query("SELECT 1");
  await checkProviders(providers);
  ready = true;
  while (!stopping) {
    let worked = false;
    if (Date.now() - lastReminderSweep >= reminderSweepMs) {
      lastReminderSweep = Date.now();
      try {
        for (let index = 0; index < maxBatch && await sweepReminder(pool); index += 1) {
          worked = true;
        }
      } catch (error) {
        if (!(error instanceof FencePaused)) throw error;
      }
    }
    for (let index = 0; index < maxBatch; index += 1) {
      let row: OutboxRow | undefined;
      try {
        row = await claim(pool);
      } catch (error) {
        if (error instanceof FencePaused) break;
        throw error;
      }
      if (row === undefined) break;
      worked = true;
      try {
        const completedInDispatch = await processMessage(pool, row);
        if (!completedInDispatch) await complete(pool, row);
      } catch (error) {
        if (error instanceof FencePaused) await pause(pool, row);
        else await fail(pool, row, error);
      }
    }
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  ready = false;
  health.close();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}

loop().catch(async () => {
  process.exitCode = 1;
  await shutdown();
});
