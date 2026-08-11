import {
  apiErrorSchemaId,
  commandHeadersSchema,
  commandResponseSchema,
  markNotificationReadCommandSchema,
  notificationsResponseSchema,
  notificationsSchemaId,
  type Notification,
  type NotificationChannel,
  type NotificationsResponse,
  type NotificationStatus,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { PlatformError } from "../../errors.js";
import { createAuditWriter } from "../../infrastructure/audit.js";
import type {
  DatabaseClient,
  QueryExecutor,
} from "../../infrastructure/database.js";
import { executeCommand } from "../../platform/commands.js";
import { requireCsrf, requireSameOrigin } from "../../platform/security.js";
import type { AccessContext } from "../auth/index.js";

const NOTIFICATION_LIMIT = 100;
const NOTIFICATION_COLUMNS = `SELECT
  id,
  recipient_user_id AS recipientUserId,
  recipient_role AS recipientRole,
  recipient_factory_id AS recipientFactoryId,
  recipient_supplier_id AS recipientSupplierId,
  channel,
  type,
  severity,
  title,
  message,
  entity_type AS entityType,
  entity_id AS entityId,
  business_no AS businessNo,
  status,
  sent_at AS sentAt,
  read_at AS readAt,
  error_message AS errorMessage,
  created_at AS createdAt
FROM notification_messages`;

type NotificationsAccessContext = Pick<
  AccessContext,
  "localPreview" | "sessionId" | "userId"
>;
type DataRow = Record<string, unknown>;

export interface NotificationsModuleOptions {
  authenticate: (
    request: FastifyRequest,
  ) => Promise<NotificationsAccessContext>;
  database?: DatabaseClient;
}

export class NotificationsUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Notifications unavailable");
    this.name = "NotificationsUnavailableError";
  }
}

function invalidData(): never {
  throw new NotificationsUnavailableError();
}

function integer(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return invalidData();
  }
  return value;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalidData();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value, true);
}

function enumeration<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    return invalidData();
  }
  return value as Value;
}

function notification(row: DataRow, userId: number): Notification {
  const recipientUserId = integer(row.recipientUserId);
  if (recipientUserId !== userId) return invalidData();

  return {
    id: integer(row.id),
    recipientUserId,
    recipientRole: nullableString(row.recipientRole),
    recipientFactoryId: nullableInteger(row.recipientFactoryId),
    recipientSupplierId: nullableInteger(row.recipientSupplierId),
    channel: enumeration<NotificationChannel>(row.channel, [
      "in_app",
      "email",
    ]),
    type: string(row.type),
    severity: string(row.severity),
    title: string(row.title),
    message: string(row.message),
    entityType: string(row.entityType),
    entityId: integer(row.entityId),
    businessNo: nullableString(row.businessNo),
    status: enumeration<NotificationStatus>(row.status, [
      "queued",
      "sent",
      "failed",
      "read",
    ]),
    sentAt: nullableString(row.sentAt),
    readAt: nullableString(row.readAt),
    errorMessage: nullableString(row.errorMessage),
    createdAt: string(row.createdAt),
  };
}

async function readNotifications(
  database: QueryExecutor,
  userId: number,
): Promise<NotificationsResponse> {
  try {
    const rows = await database.query<DataRow>(
      `${NOTIFICATION_COLUMNS}
WHERE recipient_user_id = ?
ORDER BY created_at DESC, id DESC
LIMIT ${NOTIFICATION_LIMIT}`,
      [userId],
    );
    if (rows.length > NOTIFICATION_LIMIT) return invalidData();
    const notifications = rows.map((row) => notification(row, userId));
    return {
      notifications,
      unread: notifications.filter(
        (row) => row.readAt === null || row.readAt === "",
      ).length,
    };
  } catch (error) {
    if (error instanceof NotificationsUnavailableError) throw error;
    throw new NotificationsUnavailableError();
  }
}

export async function registerNotificationsModule(
  app: FastifyInstance,
  options: NotificationsModuleOptions,
): Promise<void> {
  if (!app.getSchema(notificationsSchemaId)) {
    app.addSchema(notificationsResponseSchema);
  }

  app.get<{ Reply: NotificationsResponse }>(
    "/api/v1/notifications",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["notifications"],
        summary: "Read notifications for the authenticated user",
        response: {
          200: { $ref: `${notificationsSchemaId}#` },
          401: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview) {
        return { notifications: [], unread: 0, preview: true };
      }
      if (options.database === undefined) {
        throw new NotificationsUnavailableError();
      }
      return readNotifications(options.database, integer(access.userId));
    },
  );

  app.post<{ Body: { id: number } }>(
    "/api/v1/notifications/read",
    {
      schema: {
        tags: ["notifications"],
        summary: "Mark an owned notification as read",
        headers: commandHeadersSchema,
        body: markNotificationReadCommandSchema,
        response: {
          200: commandResponseSchema,
          "4xx": { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      requireSameOrigin(request);
      requireCsrf(request);
      const access = await options.authenticate(request);
      if (access.localPreview || access.sessionId === null) {
        throw new PlatformError(403, "FORBIDDEN", "Authenticated session required");
      }
      if (options.database === undefined) throw new NotificationsUnavailableError();
      const response = await executeCommand({
        actorScope: `user:${access.userId}`,
        command: "notifications.mark-read",
        database: options.database,
        payload: request.body,
        request,
        run: async ({ transaction }) => {
          const rows = await transaction.query<Record<string, unknown>>(
            `SELECT id, status, read_at AS readAt
             FROM notification_messages
             WHERE id = ? AND recipient_user_id = ?
             LIMIT 1 FOR UPDATE`,
            [request.body.id, access.userId],
          );
          const row = rows[0];
          if (row === undefined) {
            throw new PlatformError(404, "NOT_FOUND", "Notification not found");
          }
          if (row.readAt === null || row.readAt === "") {
            const changed = await transaction.execute(
              `UPDATE notification_messages
               SET status = 'read', read_at = CURRENT_TIMESTAMP(3)
               WHERE id = ? AND recipient_user_id = ? AND read_at IS NULL`,
              [request.body.id, access.userId],
            );
            if (changed.affectedRows !== 1) {
              throw new PlatformError(409, "VERSION_CONFLICT", "Notification state changed");
            }
          }
          await createAuditWriter({ database: transaction })({
            access,
            action: "mark_read",
            module: "notifications",
            entityType: "notification",
            entityId: request.body.id,
            request,
          });
          return { success: true, id: request.body.id, status: "read" };
        },
      });
      return reply.status(response.statusCode).send(response.body);
    },
  );
}
