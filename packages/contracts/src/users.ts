export const usersSchemaId = "Users";

export type UserAccountStatus =
  | "pending"
  | "active"
  | "locked"
  | "disabled";

export type UserRoleAssignmentStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked";

export interface UserRoleAssignment {
  id: number;
  roleCode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: UserRoleAssignmentStatus;
  requestedBy: number;
  reviewedBy: number | null;
  reviewedAt: string | null;
}

export interface ManagedUser {
  id: number;
  email: string;
  mobile: string;
  name: string;
  accountStatus: UserAccountStatus;
  organizationName: string;
  factoryId: number | null;
  supplierId: number | null;
  roles: string[];
  roleAssignments: UserRoleAssignment[];
  createdAt: string;
  updatedAt: string;
}

export interface UsersResponse {
  users: ManagedUser[];
  preview?: true;
}

const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nullablePositiveIntegerSchema = {
  anyOf: [{ type: "null" }, positiveIntegerSchema],
} as const;
const nullableStringSchema = {
  anyOf: [{ type: "null" }, { type: "string" }],
} as const;

const roleAssignmentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "roleCode",
    "effectiveFrom",
    "effectiveTo",
    "status",
    "requestedBy",
    "reviewedBy",
    "reviewedAt",
  ],
  properties: {
    id: positiveIntegerSchema,
    roleCode: { type: "string", minLength: 1 },
    effectiveFrom: { type: "string", minLength: 1 },
    effectiveTo: nullableStringSchema,
    status: {
      type: "string",
      enum: ["pending", "active", "expired", "revoked"],
    },
    requestedBy: positiveIntegerSchema,
    reviewedBy: nullablePositiveIntegerSchema,
    reviewedAt: nullableStringSchema,
  },
} as const;

export const usersResponseSchema = {
  $id: usersSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["users"],
  properties: {
    users: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "email",
          "mobile",
          "name",
          "accountStatus",
          "organizationName",
          "factoryId",
          "supplierId",
          "roles",
          "roleAssignments",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: positiveIntegerSchema,
          email: { type: "string", minLength: 1 },
          mobile: { type: "string" },
          name: { type: "string", minLength: 1 },
          accountStatus: {
            type: "string",
            enum: ["pending", "active", "locked", "disabled"],
          },
          organizationName: { type: "string" },
          factoryId: nullablePositiveIntegerSchema,
          supplierId: nullablePositiveIntegerSchema,
          roles: {
            type: "array",
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          roleAssignments: {
            type: "array",
            maxItems: 5_000,
            items: roleAssignmentSchema,
          },
          createdAt: { type: "string", minLength: 1 },
          updatedAt: { type: "string", minLength: 1 },
        },
      },
    },
    preview: { const: true },
  },
} as const;
