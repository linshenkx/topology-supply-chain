export const healthLiveSchemaId = "HealthLive";
export const healthReadySchemaId = "HealthReady";

export interface HealthLiveResponse {
  status: "ok";
  service: string;
  timestamp: string;
  uptimeSeconds: number;
}

export interface HealthReadyCheck {
  name: string;
  status: "ok" | "failed";
}

export interface HealthReadyResponse {
  status: "ok" | "not_ready";
  service: string;
  timestamp: string;
  checks: HealthReadyCheck[];
}

export const healthLiveResponseSchema = {
  $id: healthLiveSchemaId,
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "timestamp", "uptimeSeconds"],
  properties: {
    status: { const: "ok" },
    service: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    uptimeSeconds: { type: "number", minimum: 0 },
  },
} as const;

export const healthReadyResponseSchema = {
  $id: healthReadySchemaId,
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "timestamp", "checks"],
  properties: {
    status: { type: "string", enum: ["ok", "not_ready"] },
    service: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["ok", "failed"] },
        },
      },
    },
  },
} as const;
