"use client";

import {
  R2_COMMAND_BY_MUTATION,
  type R2MutationPath,
} from "./r2-mutation-contract";

type CorePlatformMutationPath =
  | "/api/v1/auth/login"
  | "/api/v1/auth/verify"
  | "/api/v1/auth/logout"
  | "/api/v1/auth/step-up/request"
  | "/api/v1/auth/step-up/verify"
  | "/api/v1/users"
  | "/api/v1/files"
  | "/api/v1/notifications/read"
  | "/api/v1/approvals"
  | "/api/v1/inventory"
  | "/api/v1/inventory/transfers"
  | "/api/v1/production-orders"
  | "/api/v1/quality-inspections"
  | "/api/v1/stocktakes"
  | "/api/v1/shipments"
  | "/api/v1/returns"
  | "/api/v1/finance"
  | "/api/v1/warehouses";

export type PlatformMutationPath = CorePlatformMutationPath | R2MutationPath;

type MutationMethod = "POST" | "PATCH" | "DELETE";

interface CommandEnvelope<Result> {
  command: {
    command: string;
    idempotencyKey: string;
    requestDigest: string;
    replayed: boolean;
  };
  result: Result;
}

export class MutationError extends Error {
  readonly code: string;
  readonly idempotencyKey: string;
  readonly outcomeUnknown: boolean;

  constructor(message: string, code: string, idempotencyKey: string) {
    super(message);
    this.name = "MutationError";
    this.code = code;
    this.idempotencyKey = idempotencyKey;
    this.outcomeUnknown = code === "COMMAND_OUTCOME_UNKNOWN" || code === "NETWORK_OUTCOME_UNKNOWN";
  }
}

const COMMAND_BY_PATH: Readonly<Record<CorePlatformMutationPath, string>> = {
  "/api/v1/auth/login": "auth.login",
  "/api/v1/auth/verify": "auth.verify",
  "/api/v1/auth/logout": "auth.logout",
  "/api/v1/auth/step-up/request": "step-up.request",
  "/api/v1/auth/step-up/verify": "step-up.verify",
  "/api/v1/users": "users.assign-role",
  "/api/v1/files": "files.upload",
  "/api/v1/notifications/read": "notifications.mark-read",
  "/api/v1/approvals": "approvals.decide",
  "/api/v1/inventory": "inventory.reserve",
  "/api/v1/inventory/transfers": "inventory.transfer.request",
  "/api/v1/production-orders": "manufacturing.order.create",
  "/api/v1/quality-inspections": "quality.inspection.submit",
  "/api/v1/stocktakes": "inventory.stocktake.open",
  "/api/v1/shipments": "logistics.shipment.command",
  "/api/v1/returns": "returns.command",
  "/api/v1/finance": "finance.command",
  "/api/v1/warehouses": "warehouses.command",
};

function commandName(path: PlatformMutationPath, method: MutationMethod): string {
  const r2 = R2_COMMAND_BY_MUTATION[`${method} ${path}` as keyof typeof R2_COMMAND_BY_MUTATION];
  if (r2 !== undefined) return r2;
  if (path === "/api/v1/users") {
    return method === "POST" ? "users.assign-role" : method === "PATCH" ? "users.unlock" : "users.revoke-role";
  }
  if (path === "/api/v1/inventory/transfers" && method === "PATCH") return "inventory.transfer.transition";
  if (path === "/api/v1/production-orders" && method === "PATCH") return "manufacturing.order.transition";
  if (path === "/api/v1/stocktakes" && method === "PATCH") return "inventory.stocktake.transition";
  return COMMAND_BY_PATH[path as CorePlatformMutationPath];
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function finalRequestDigest(payload: Record<string, unknown>): Promise<string> {
  return sha256(canonical(payload));
}

async function pendingKey(path: PlatformMutationPath, method: MutationMethod, body: unknown): Promise<{ id: string; key: string }> {
  const id = `topology:pending:${await sha256(`${method}:${path}:${canonical(body)}`)}`;
  const existing = sessionStorage.getItem(id);
  const key = existing && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(existing)
    ? existing : crypto.randomUUID();
  sessionStorage.setItem(id, key);
  return { id, key };
}

interface PendingUploadState {
  fileId?: number;
  idempotencyKey: string;
  result?: unknown;
}

function uploadFingerprint(form: FormData): unknown {
  return Array.from(form.entries()).map(([key, value]) =>
    [key, typeof value === "string" ? value : `${value.name}:${value.size}:${value.lastModified}`]);
}

async function pendingUpload(form: FormData): Promise<{ id: string; state: PendingUploadState }> {
  const id = `topology:upload:${await sha256(canonical(uploadFingerprint(form)))}`;
  const raw = sessionStorage.getItem(id);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<PendingUploadState>;
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(parsed.idempotencyKey ?? "") &&
          (parsed.fileId === undefined || (Number.isSafeInteger(parsed.fileId) && (parsed.fileId ?? 0) > 0))) {
        return { id, state: parsed as PendingUploadState };
      }
    } catch {
      // Replace malformed browser state with a fresh bounded command key.
    }
  }
  const state = { idempotencyKey: crypto.randomUUID() };
  sessionStorage.setItem(id, JSON.stringify(state));
  return { id, state };
}

function savePendingUpload(id: string, state: PendingUploadState): void {
  sessionStorage.setItem(id, JSON.stringify(state));
}

function cookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function headers(idempotencyKey: string, csrf: boolean): Record<string, string> {
  const result: Record<string, string> = { "idempotency-key": idempotencyKey };
  if (csrf) {
    const token = cookie("topology_csrf");
    if (!token) throw new MutationError("安全会话已过期，请重新登录。", "CSRF_REJECTED", idempotencyKey);
    result["x-csrf-token"] = token;
  }
  return result;
}

async function decode<Result>(
  response: Response,
  idempotencyKey: string,
): Promise<Result> {
  const body = await response.json().catch(() => ({})) as Partial<CommandEnvelope<Result>> & {
    code?: string;
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    const proxyOutcomeUnknown = response.status === 502 || response.status === 504 ||
      (response.status >= 500 && (body.code === undefined || body.code === "REQUEST_FAILED"));
    const code = proxyOutcomeUnknown ? "NETWORK_OUTCOME_UNKNOWN" : body.code ?? "REQUEST_FAILED";
    const message = body.message ?? body.error ?? `请求失败（${response.status}）`;
    throw new MutationError(
      code === "COMMAND_OUTCOME_UNKNOWN" || code === "NETWORK_OUTCOME_UNKNOWN"
        ? `${message} 请勿创建新请求；仅可使用幂等键 ${idempotencyKey} 对账或重放。`
        : message,
      code,
      idempotencyKey,
    );
  }
  if (body.result === undefined || body.command === undefined) {
    throw new MutationError("服务端返回了无效的写入结果。", "INVALID_RESPONSE", idempotencyKey);
  }
  return body.result;
}

export async function mutateJson<Result, Body extends Record<string, unknown>>(
  path: PlatformMutationPath,
  method: MutationMethod,
  body: Body,
  options: { csrf?: boolean; digestBody?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<Result> {
  const pending = await pendingKey(path, method, body);
  const idempotencyKey = options.idempotencyKey ?? pending.key;
  if (options.idempotencyKey !== undefined) sessionStorage.setItem(pending.id, idempotencyKey);
  const requestDigest = await sha256(canonical({ command: commandName(path, method), payload: options.digestBody ?? body }));
  try {
    const response = await fetch(path, {
      method,
      headers: {
        ...headers(idempotencyKey, options.csrf !== false),
        "content-type": "application/json",
        "x-request-digest": requestDigest,
      },
      body: JSON.stringify(body),
    });
    const result = await decode<Result>(response, idempotencyKey);
    sessionStorage.removeItem(pending.id);
    return result;
  } catch (error) {
    if (error instanceof MutationError) {
      if (!error.outcomeUnknown) sessionStorage.removeItem(pending.id);
      throw error;
    }
    throw new MutationError(
      `请求结果未知；请使用同一幂等键 ${idempotencyKey} 重试。`,
      "NETWORK_OUTCOME_UNKNOWN",
      idempotencyKey,
    );
  }
}
export async function uploadPlatformFile<Result>(
  form: FormData,
  idempotencyKey?: string,
): Promise<Result> {
  const pending = await pendingUpload(form);
  const state = pending.state;
  const key = idempotencyKey ?? state.idempotencyKey;
  if (idempotencyKey !== undefined) {
    state.idempotencyKey = idempotencyKey;
    savePendingUpload(pending.id, state);
  }
  try {
    let envelope = state.result as (Result & { file?: { id?: unknown; scanStatus?: string }; usable?: boolean }) | undefined;
    if (state.fileId === undefined) {
      const response = await fetch("/api/v1/files", { method: "POST", headers: headers(key, true), body: form });
      envelope = await decode<Result>(response, key) as Result & { file?: { id?: unknown; scanStatus?: string }; usable?: boolean };
      if (!Number.isSafeInteger(envelope.file?.id)) {
        sessionStorage.removeItem(pending.id);
        throw new MutationError("上传结果缺少文件标识。", "INVALID_RESPONSE", key);
      }
      state.fileId = Number(envelope.file?.id);
      state.result = envelope;
      savePendingUpload(pending.id, state);
    }
    if (envelope === undefined) {
      envelope = { file: { id: state.fileId, scanStatus: "quarantined" }, usable: false } as Result & { file: { id: number; scanStatus: string }; usable: boolean };
    }
    if (envelope.usable === false && state.fileId !== undefined) {
      const status = await waitForPlatformFile(state.fileId);
      envelope.usable = status.usable;
      if (envelope.file) envelope.file.scanStatus = status.scanStatus;
    }
    sessionStorage.removeItem(pending.id);
    return envelope;
  } catch (error) {
    if (error instanceof MutationError && error.code === "FILE_SCAN_REJECTED") {
      sessionStorage.removeItem(pending.id);
    } else if (state.fileId === undefined && error instanceof MutationError && !error.outcomeUnknown) {
      sessionStorage.removeItem(pending.id);
    }
    if (error instanceof MutationError) throw error;
    throw new MutationError(`上传结果未知；请使用同一幂等键 ${key} 重试。`, "NETWORK_OUTCOME_UNKNOWN", key);
  }
}

export async function cancelPendingPlatformFileUpload(form: FormData): Promise<void> {
  const pending = await pendingUpload(form);
  sessionStorage.removeItem(pending.id);
}

export async function waitForPlatformFile(
  fileId: number,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ id: number; scanStatus: "clean" | "quarantined" | "rejected"; usable: boolean }> {
  const attempts = options.attempts ?? 60;
  const delayMs = options.delayMs ?? 2_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`/api/v1/files/status?id=${fileId}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as { id?: number; scanStatus?: string; usable?: boolean; message?: string };
    if (!response.ok) throw new MutationError(body.message ?? "文件扫描状态查询失败。", "FILE_SCAN_STATUS_FAILED", `file:${fileId}`);
    if (body.scanStatus === "clean" && body.usable === true) return { id: fileId, scanStatus: "clean", usable: true };
    if (body.scanStatus === "rejected") throw new MutationError("文件未通过安全扫描，不能用于业务操作。", "FILE_SCAN_REJECTED", `file:${fileId}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new MutationError("文件仍在安全扫描中，请稍后从当前页面重试。", "FILE_SCAN_PENDING", `file:${fileId}`);
}
