export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const CSRF_TOKEN_HEADER = "x-csrf-token";
export const REQUEST_DIGEST_HEADER = "x-request-digest";

export type PlatformCommandName =
  | "auth.login"
  | "auth.verify"
  | "auth.logout"
  | "step-up.request"
  | "step-up.verify"
  | "users.create"
  | "users.reset-password"
  | "users.disable"
  | "users.restore"
  | "users.assign-role"
  | "users.revoke-role"
  | "users.unlock"
  | "files.upload"
  | "notifications.mark-read";

export interface CommandMetadata {
  command: PlatformCommandName;
  idempotencyKey: string;
  requestDigest: string;
  replayed: boolean;
}

export interface CommandResponse<Result = Record<string, unknown>> {
  command: CommandMetadata;
  result: Result;
}

export const commandHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [IDEMPOTENCY_KEY_HEADER],
  properties: {
    [IDEMPOTENCY_KEY_HEADER]: {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$",
    },
    [CSRF_TOKEN_HEADER]: {
      type: "string",
      minLength: 32,
      maxLength: 128,
      pattern: "^[A-Fa-f0-9]+$",
    },
    [REQUEST_DIGEST_HEADER]: {
      type: "string",
      minLength: 64,
      maxLength: 64,
      pattern: "^[A-Fa-f0-9]{64}$",
    },
  },
} as const;
export const loginCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["account", "password", "deviceId"],
  properties: {
    account: { type: "string", minLength: 3, maxLength: 191 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
    deviceId: { type: "string", minLength: 8, maxLength: 191 },
    deviceName: { type: "string", maxLength: 200 },
  },
} as const;

export const loginVerifyCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["challengeNo", "code"],
  properties: {
    challengeNo: { type: "string", minLength: 8, maxLength: 191 },
    code: { type: "string", pattern: "^\\d{6}$" },
    deviceName: { type: "string", maxLength: 200 },
  },
} as const;

export const stepUpRequestCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "objectType", "objectId", "objectVersion", "requestDigest"],
  properties: {
    action: { type: "string", minLength: 1, maxLength: 100 },
    objectType: { type: "string", minLength: 1, maxLength: 100 },
    objectId: { type: "string", minLength: 1, maxLength: 191 },
    objectVersion: { type: "integer", minimum: 1 },
    requestDigest: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
  },
} as const;

export const stepUpVerifyCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["challengeNo", "code"],
  properties: {
    challengeNo: { type: "string", minLength: 8, maxLength: 191 },
    code: { type: "string", pattern: "^\\d{6}$" },
  },
} as const;

const managedPasswordSchema = {
  type: "string",
  minLength: 12,
  maxLength: 128,
} as const;

export const createUserCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "mobile", "name", "organizationName", "roleCode", "initialPassword"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 191 },
    mobile: { type: "string", pattern: "^1\\d{10}$" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    organizationName: { type: "string", minLength: 1, maxLength: 200 },
    roleCode: {
      type: "string",
      enum: ["supply_chain", "finance", "company_qc", "receiver"],
    },
    initialPassword: managedPasswordSchema,
  },
} as const;

export const resetUserPasswordCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "newPassword"],
  properties: {
    userId: { type: "integer", minimum: 1 },
    newPassword: managedPasswordSchema,
  },
} as const;

export const disableUserCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: { userId: { type: "integer", minimum: 1 } },
} as const;

export const restoreUserCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId"],
  properties: { userId: { type: "integer", minimum: 1 } },
} as const;

export const assignUserRoleCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "roleCode", "effectiveFrom", "reason"],
  properties: {
    userId: { type: "integer", minimum: 1 },
    roleCode: { type: "string", minLength: 1, maxLength: 100 },
    effectiveFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    effectiveTo: {
      anyOf: [
        { type: "null" },
        { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      ],
    },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;

export const revokeUserRoleCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["roleAssignmentId", "reason"],
  properties: {
    roleAssignmentId: { type: "integer", minimum: 1 },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;

export const unlockUserCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["userId", "action"],
  properties: {
    userId: { type: "integer", minimum: 1 },
    action: { const: "unlock" },
  },
} as const;

export const markNotificationReadCommandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

export const commandResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command", "result"],
  properties: {
    command: {
      type: "object",
      additionalProperties: false,
      required: ["command", "idempotencyKey", "requestDigest", "replayed"],
      properties: {
        command: { type: "string", minLength: 1 },
        idempotencyKey: { type: "string", minLength: 16, maxLength: 128 },
        requestDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        replayed: { type: "boolean" },
      },
    },
    result: { type: "object", additionalProperties: true },
  },
} as const;
