export const sessionSchemaId = "Session";

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  roles: string[];
  factoryId: number | null;
  supplierId: number | null;
}

export interface SessionSecurityPolicy {
  passwordAttemptsBeforeLock: number;
  trustedDeviceDays: number;
  highRiskRequiresSms: boolean;
  separationOfDuties: boolean;
}

export interface SessionResponse {
  user: SessionUser;
  security: SessionSecurityPolicy;
  localPreview: boolean;
}

export const sessionResponseSchema = {
  $id: sessionSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["user", "security", "localPreview"],
  properties: {
    user: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "email",
        "name",
        "roles",
        "factoryId",
        "supplierId",
      ],
      properties: {
        id: { type: "integer", minimum: 0 },
        email: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        roles: {
          type: "array",
          items: { type: "string", minLength: 1 },
          uniqueItems: true,
        },
        factoryId: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] },
        supplierId: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] },
      },
    },
    security: {
      type: "object",
      additionalProperties: false,
      required: [
        "passwordAttemptsBeforeLock",
        "trustedDeviceDays",
        "highRiskRequiresSms",
        "separationOfDuties",
      ],
      properties: {
        passwordAttemptsBeforeLock: { type: "integer", minimum: 1 },
        trustedDeviceDays: { type: "integer", minimum: 1 },
        highRiskRequiresSms: { type: "boolean" },
        separationOfDuties: { type: "boolean" },
      },
    },
    localPreview: { type: "boolean" },
  },
} as const;
