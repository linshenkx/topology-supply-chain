import { createDecipheriv } from "node:crypto";

export class PermanentProviderFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PermanentProviderFailure";
    this.code = code;
  }
}

interface SealedValue {
  ciphertext: string;
  iv: string;
  keyId: string;
  tag: string;
}

interface ProviderEndpoint {
  apiKey: string;
  healthUrl: string;
  url: string;
}

export interface WorkerProviders {
  email: ProviderEndpoint;
  scanner: ProviderEndpoint;
  sealingKeys: ReadonlyMap<string, Buffer>;
  sms: ProviderEndpoint;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function endpoint(environment: NodeJS.ProcessEnv, prefix: string): ProviderEndpoint {
  return {
    apiKey: required(environment, `${prefix}_API_KEY`),
    healthUrl: required(environment, `${prefix}_HEALTH_URL`),
    url: required(environment, `${prefix}_URL`),
  };
}

export function readWorkerProviders(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerProviders {
  const raw = required(environment, "OTP_SEALING_KEYS_JSON");
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error("OTP_SEALING_KEYS_JSON must be a JSON object");
  }
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("OTP_SEALING_KEYS_JSON must be a JSON object");
  }
  const sealingKeys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(values)) {
    if (typeof encoded !== "string" || !/^[a-f\d]{64}$/iu.test(encoded)) {
      throw new Error("OTP sealing keys must be 32-byte hexadecimal values");
    }
    sealingKeys.set(keyId, Buffer.from(encoded, "hex"));
  }
  if (sealingKeys.size === 0) throw new Error("At least one OTP sealing key is required");
  return {
    email: endpoint(environment, "EMAIL_WEBHOOK"),
    scanner: endpoint(environment, "FILE_SCAN_WEBHOOK"),
    sealingKeys,
    sms: endpoint(environment, "SMS_WEBHOOK"),
  };
}

async function request(
  endpointValue: ProviderEndpoint,
  method: "GET" | "POST",
  body?: string,
  idempotencyKey?: string,
): Promise<Response> {
  const response = await fetch(method === "GET" ? endpointValue.healthUrl : endpointValue.url, {
    method,
    headers: {
      "x-api-key": endpointValue.apiKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new PermanentProviderFailure(`PROVIDER_${response.status}`);
    }
    throw new Error(`PROVIDER_${response.status}`);
  }
  return response;
}

export async function checkProviders(providers: WorkerProviders): Promise<void> {
  await Promise.all([
    request(providers.email, "GET"),
    request(providers.sms, "GET"),
    request(providers.scanner, "GET"),
  ]);
}

export async function deliverEmail(
  providers: WorkerProviders,
  payloadJson: string,
  idempotencyKey: string,
): Promise<void> {
  await request(providers.email, "POST", payloadJson, idempotencyKey);
}

export function unsealOtp(
  providers: WorkerProviders,
  value: unknown,
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentProviderFailure("INVALID_SEALED_OTP");
  }
  const sealed = value as Partial<SealedValue>;
  if (![sealed.keyId, sealed.iv, sealed.ciphertext, sealed.tag].every((part) => typeof part === "string")) {
    throw new PermanentProviderFailure("INVALID_SEALED_OTP");
  }
  const key = providers.sealingKeys.get(sealed.keyId as string);
  if (key === undefined) throw new PermanentProviderFailure("OTP_SEALING_KEY_UNAVAILABLE");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv as string, "base64url"));
    decipher.setAuthTag(Buffer.from(sealed.tag as string, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext as string, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new PermanentProviderFailure("INVALID_SEALED_OTP");
  }
}

export async function deliverSms(
  providers: WorkerProviders,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  const code = unsealOtp(providers, payload.sealedCode);
  const outbound = JSON.stringify({ ...payload, sealedCode: undefined, code });
  await request(providers.sms, "POST", outbound, idempotencyKey);
}

export async function scanFile(
  providers: WorkerProviders,
  payloadJson: string,
  idempotencyKey: string,
): Promise<"clean" | "rejected"> {
  const response = await request(providers.scanner, "POST", payloadJson, idempotencyKey);
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || !("status" in body)) {
    throw new PermanentProviderFailure("INVALID_SCANNER_RESPONSE");
  }
  const status = (body as { status?: unknown }).status;
  if (status !== "clean" && status !== "rejected") {
    throw new PermanentProviderFailure("INVALID_SCANNER_RESPONSE");
  }
  return status;
}
