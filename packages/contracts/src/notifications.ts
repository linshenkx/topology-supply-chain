export const notificationsSchemaId = "Notifications";

export type NotificationChannel = "in_app" | "email";
export type NotificationStatus = "queued" | "sent" | "failed" | "read";

export interface Notification {
  id: number;
  recipientUserId: number;
  recipientRole: string | null;
  recipientFactoryId: number | null;
  recipientSupplierId: number | null;
  channel: NotificationChannel;
  type: string;
  severity: string;
  title: string;
  message: string;
  entityType: string;
  entityId: number;
  businessNo: string | null;
  status: NotificationStatus;
  sentAt: string | null;
  readAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unread: number;
  preview?: true;
}

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nullablePositiveIntegerSchema = {
  anyOf: [{ type: "null" }, positiveIntegerSchema],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

export const notificationsResponseSchema = {
  $id: notificationsSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["notifications", "unread"],
  properties: {
    notifications: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "recipientUserId",
          "recipientRole",
          "recipientFactoryId",
          "recipientSupplierId",
          "channel",
          "type",
          "severity",
          "title",
          "message",
          "entityType",
          "entityId",
          "businessNo",
          "status",
          "sentAt",
          "readAt",
          "errorMessage",
          "createdAt",
        ],
        properties: {
          id: positiveIntegerSchema,
          recipientUserId: positiveIntegerSchema,
          recipientRole: nullableStringSchema,
          recipientFactoryId: nullablePositiveIntegerSchema,
          recipientSupplierId: nullablePositiveIntegerSchema,
          channel: { type: "string", enum: ["in_app", "email"] },
          type: { type: "string", minLength: 1 },
          severity: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
          entityType: { type: "string", minLength: 1 },
          entityId: positiveIntegerSchema,
          businessNo: nullableStringSchema,
          status: {
            type: "string",
            enum: ["queued", "sent", "failed", "read"],
          },
          sentAt: nullableStringSchema,
          readAt: nullableStringSchema,
          errorMessage: nullableStringSchema,
          createdAt: { type: "string", minLength: 1 },
        },
      },
    },
    unread: { type: "integer", minimum: 0, maximum: 100 },
    preview: { const: true },
  },
} as const;
