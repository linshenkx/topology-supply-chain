import {
  apiErrorSchemaId,
  commandHeadersSchema,
  commandResponseSchema,
  fileDownloadQuerySchema,
  fileDownloadResponseSchema,
  type FileDownloadQuery,
} from "@topology/contracts";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";

import { PlatformError } from "../../errors.js";
import { createAuditWriter } from "../../infrastructure/audit.js";
import type {
  DatabaseClient,
  QueryExecutor,
} from "../../infrastructure/database.js";
import { executeCommand, readIdempotencyKey } from "../../platform/commands.js";
import { enqueueOutbox } from "../../platform/outbox.js";
import { requireCsrf, requireSameOrigin } from "../../platform/security.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "company_qc",
]);
const REQUIRED_ENTITY_TYPE_BY_CATEGORY = new Map([
  ["import", "import_upload"],
  ["import_source", "import_upload"],
  ["invoice", "purchase_order"],
  ["shipment_evidence", "delivery_batch"],
  ["receipt_evidence", "delivery_batch"],
  ["quality_evidence", "product_return"],
  ["price_evidence", "supplier_sku"],
]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const MAX_FILE_SIZE_BYTES = 20 * 1_024 * 1_024;

const FILE_COLUMNS = `SELECT
  id,
  object_key AS objectKey,
  file_name AS fileName,
  content_type AS contentType,
  size_bytes AS sizeBytes,
  category,
  entity_type AS entityType,
  entity_id AS entityId,
  owner_user_id AS ownerUserId,
  factory_id AS factoryId,
  supplier_id AS supplierId,
  file_objects.\`sensitive\` AS \`sensitive\`,
  scan_status AS scanStatus,
  retain_until AS retainUntil,
  created_at AS createdAt
FROM file_objects`;

type FilesAccessContext = Pick<
  AccessContext,
  | "email"
  | "factoryId"
  | "localPreview"
  | "name"
  | "organizationName"
  | "roles"
  | "sessionId"
  | "supplierId"
  | "userId"
>;
type DataRow = Record<string, unknown>;

interface FileObjectRecord {
  id: number;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  category: string;
  entityType: string | null;
  entityId: string | null;
  ownerUserId: number;
  factoryId: number | null;
  supplierId: number | null;
  sensitive: boolean;
  retainUntil: string | null;
  createdAt: string;
  scanStatus: "quarantined" | "clean" | "rejected";
}

export interface FileDownloadAuditEvent {
  access: FilesAccessContext;
  action: "download";
  entityId: number;
  entityType: "file";
  module: "files";
  request: FastifyRequest;
  sensitiveView: boolean;
}

export interface FileStoragePort {
  deleteObject?(objectKey: string): Promise<void>;
  readObject(objectKey: string): Promise<Uint8Array | null>;
  writeQuarantinedObject?(
    objectKey: string,
    body: Uint8Array,
    metadata: { contentType: string; sha256: string; uploadedBy: number },
  ): Promise<void>;
}

export interface FilesModuleOptions {
  audit: (event: FileDownloadAuditEvent) => Promise<void> | void;
  authenticate: (request: FastifyRequest) => Promise<FilesAccessContext>;
  database?: DatabaseClient;
  storage?: FileStoragePort;
  scannerReady?: () => Promise<void>;
  authorizeEntity?: (input: {
    access: FilesAccessContext;
    entityId: string;
    entityType: string;
    operation: "read" | "write";
  }) => Promise<boolean>;
}

export class FileNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("File not found");
    this.name = "FileNotFoundError";
  }
}

export class FileForbiddenError extends Error {
  readonly statusCode = 403;

  constructor() {
    super("File access forbidden");
    this.name = "FileForbiddenError";
  }
}

export class FilesUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("Files unavailable");
    this.name = "FilesUnavailableError";
  }
}

function invalidData(): never {
  throw new FilesUnavailableError();
}

function integer(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
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

function headerString(value: unknown): string {
  const result = string(value);
  if (/\r|\n/u.test(result)) return invalidData();
  return result;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value, true);
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidData();
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

function fileObject(row: DataRow): FileObjectRecord {
  const contentType = headerString(row.contentType);
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return invalidData();
  const sizeBytes = integer(row.sizeBytes, true);
  if (sizeBytes > MAX_FILE_SIZE_BYTES) return invalidData();

  return {
    id: integer(row.id),
    objectKey: string(row.objectKey),
    fileName: headerString(row.fileName),
    contentType,
    sizeBytes,
    category: string(row.category),
    entityType: nullableString(row.entityType),
    entityId: nullableString(row.entityId),
    ownerUserId: integer(row.ownerUserId),
    factoryId: nullableInteger(row.factoryId),
    supplierId: nullableInteger(row.supplierId),
    sensitive: boolean(row.sensitive),
    retainUntil: nullableString(row.retainUntil),
    createdAt: string(row.createdAt),
    scanStatus: enumeration(row.scanStatus, ["quarantined", "clean", "rejected"]),
  };
}

function requestedId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new FileNotFoundError();
  return id;
}

function canRead(access: FilesAccessContext, record: FileObjectRecord): boolean {
  if (access.roles.some((role) => INTERNAL_ROLES.has(role))) return true;
  if (record.ownerUserId === access.userId) return true;
  if (
    access.factoryId !== null &&
    Number.isSafeInteger(access.factoryId) &&
    access.factoryId > 0 &&
    record.factoryId === access.factoryId
  ) {
    return true;
  }
  return (
    access.supplierId !== null &&
    Number.isSafeInteger(access.supplierId) &&
    access.supplierId > 0 &&
    record.supplierId === access.supplierId
  );
}

async function readRecord(
  database: QueryExecutor,
  id: number,
): Promise<FileObjectRecord | undefined> {
  try {
    const rows = await database.query<DataRow>(
      `${FILE_COLUMNS}
WHERE id = ?
ORDER BY id ASC
LIMIT 2`,
      [id],
    );
    if (rows.length > 1) return invalidData();
    return rows[0] === undefined ? undefined : fileObject(rows[0]);
  } catch (error) {
    if (error instanceof FilesUnavailableError) throw error;
    throw new FilesUnavailableError();
  }
}

export async function registerFilesModule(
  app: FastifyInstance,
  options: FilesModuleOptions,
): Promise<void> {
  await app.register(multipart, {
    limits: { files: 1, fields: 4, parts: 5, fileSize: MAX_FILE_SIZE_BYTES },
  });
  const authorizeEntity = async (
    access: FilesAccessContext,
    record: Pick<FileObjectRecord, "entityId" | "entityType">,
    operation: "read" | "write",
  ): Promise<void> => {
    if (record.entityType === null || record.entityId === null) throw new FileForbiddenError();
    if (options.authorizeEntity === undefined ||
        !(await options.authorizeEntity({ access, entityType: record.entityType, entityId: record.entityId, operation }))) {
      throw new FileForbiddenError();
    }
  };
  app.get<{ Querystring: FileDownloadQuery }>(
    "/api/v1/files",
    {
      onRequest: (_request, reply, done) => {
        reply.header("cache-control", "private, no-store");
        reply.header("pragma", "no-cache");
        reply.header("vary", "Cookie");
        done();
      },
      schema: {
        tags: ["files"],
        summary: "Download an authorized private file",
        querystring: fileDownloadQuerySchema,
        response: {
          200: {
            description: "Authorized private file content",
            content: {
              "application/pdf": { schema: fileDownloadResponseSchema },
              "image/jpeg": { schema: fileDownloadResponseSchema },
              "image/png": { schema: fileDownloadResponseSchema },
              "image/webp": { schema: fileDownloadResponseSchema },
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                schema: fileDownloadResponseSchema,
              },
              "application/vnd.ms-excel": {
                schema: fileDownloadResponseSchema,
              },
            },
          },
          401: { $ref: `${apiErrorSchemaId}#` },
          403: { $ref: `${apiErrorSchemaId}#` },
          404: { $ref: `${apiErrorSchemaId}#` },
          503: { $ref: `${apiErrorSchemaId}#` },
          "5xx": { $ref: `${apiErrorSchemaId}#` },
        },
      },
    },
    async (request, reply) => {
      const access = await options.authenticate(request);
      if (access.localPreview) throw new FileNotFoundError();
      const id = requestedId(request.query.id);
      if (options.database === undefined) throw new FilesUnavailableError();

      const record = await readRecord(options.database, id);
      if (record === undefined) throw new FileNotFoundError();
      if (!canRead(access, record)) throw new FileForbiddenError();
      await authorizeEntity(access, record, "read");
      if (record.scanStatus !== "clean") {
        throw new PlatformError(423, "FILE_QUARANTINED", "File is not available until scanning completes");
      }

      await options.audit({
        access,
        action: "download",
        module: "files",
        entityType: "file",
        entityId: record.id,
        sensitiveView: record.sensitive,
        request,
      });
      if (options.storage === undefined) throw new FilesUnavailableError();

      let body: Uint8Array | null;
      try {
        body = await options.storage.readObject(record.objectKey);
      } catch {
        throw new FilesUnavailableError();
      }
      if (body === null) throw new FileNotFoundError();
      if (!(body instanceof Uint8Array)) return invalidData();
      if (
        body.length > MAX_FILE_SIZE_BYTES ||
        body.length !== record.sizeBytes
      ) {
        return invalidData();
      }

      return reply
        .type(record.contentType)
        .header(
          "content-disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(record.fileName)}`,
        )
        .send(Buffer.from(body));
    },
  );

  app.get<{ Querystring: { id: string } }>(
    "/api/v1/files/status",
    {
      schema: {
        tags: ["files"], summary: "Read malware scan status for an authorized file",
        querystring: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^[1-9]\\d*$" } } },
        response: { 200: { type: "object", required: ["id", "scanStatus", "usable"], properties: {
          id: { type: "integer" }, scanStatus: { enum: ["quarantined", "clean", "rejected"] }, usable: { type: "boolean" },
        } }, "4xx": { $ref: `${apiErrorSchemaId}#` }, "5xx": { $ref: `${apiErrorSchemaId}#` } },
      },
    },
    async (request) => {
      const access = await options.authenticate(request);
      if (access.localPreview || options.database === undefined) throw new FileNotFoundError();
      const record = await readRecord(options.database, requestedId(request.query.id));
      if (record === undefined) throw new FileNotFoundError();
      if (!canRead(access, record)) throw new FileForbiddenError();
      await authorizeEntity(access, record, "read");
      return { id: record.id, scanStatus: record.scanStatus, usable: record.scanStatus === "clean" };
    },
  );

  app.post(
    "/api/v1/files",
    {
      schema: {
        tags: ["files"],
        summary: "Upload a private file into malware-scan quarantine",
        headers: commandHeadersSchema,
        consumes: ["multipart/form-data"],
        response: {
          201: commandResponseSchema,
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
      if (options.database === undefined || options.storage?.writeQuarantinedObject === undefined) {
        throw new FilesUnavailableError();
      }
      if (options.scannerReady === undefined) throw new FilesUnavailableError();
      try { await options.scannerReady(); } catch { throw new FilesUnavailableError(); }

      let bytes: Buffer | undefined;
      let fileName = "";
      let declaredType = "";
      const fields = new Map<string, string>();
      const allowedFields = new Set(["category", "entityType", "entityId"]);
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (bytes !== undefined || part.fieldname !== "file") {
            throw new PlatformError(400, "BAD_REQUEST", "Exactly one file is required");
          }
          fileName = part.filename;
          declaredType = part.mimetype;
          try {
            bytes = await part.toBuffer();
          } catch {
            throw new PlatformError(413, "BAD_REQUEST", "File exceeds the upload limit");
          }
        } else {
          if (
            !allowedFields.has(part.fieldname) ||
            fields.has(part.fieldname) ||
            typeof part.value !== "string" ||
            part.value.length > 191
          ) {
            throw new PlatformError(400, "BAD_REQUEST", "Invalid upload field");
          }
          fields.set(part.fieldname, part.value.trim());
        }
      }
      if (bytes === undefined || bytes.length === 0) {
        throw new PlatformError(400, "BAD_REQUEST", "File is required");
      }
      if (fileName.trim().length === 0 || fileName.length > 255) {
        throw new PlatformError(400, "BAD_REQUEST", "Invalid file name");
      }
      const category = fields.get("category") ?? "";
      const entityType = fields.get("entityType") || null;
      const entityId = fields.get("entityId") || null;
      if (category.length === 0 || category.length > 100) {
        throw new PlatformError(400, "BAD_REQUEST", "File category is required");
      }
      if ((entityType === null) !== (entityId === null)) {
        throw new PlatformError(400, "BAD_REQUEST", "File resource scope is incomplete");
      }
      const requiredEntityType = REQUIRED_ENTITY_TYPE_BY_CATEGORY.get(category);
      if (requiredEntityType !== undefined &&
          (entityType !== requiredEntityType || entityId === null || !/^[1-9]\d*$/u.test(entityId))) {
        throw new PlatformError(400, "BAD_REQUEST", "File category requires an authorized entity scope");
      }
      await authorizeEntity(access, { entityType, entityId }, "write");
      if (!ALLOWED_CONTENT_TYPES.has(declaredType) || !matchesMagic(bytes, declaredType)) {
        throw new PlatformError(415, "FILE_TYPE_REJECTED", "File content type is not allowed");
      }
      const sensitive = ["invoice", "payment", "bank_account", "price_evidence", "audit_export"].includes(category);
      const internal = access.roles.some((role) => INTERNAL_ROLES.has(role));
      const factoryPriceEvidence = category === "price_evidence" && access.roles.includes("factory");
      if (sensitive && !internal && !factoryPriceEvidence) {
        throw new FileForbiddenError();
      }
      if (!internal && access.factoryId === null && access.supplierId === null) {
        throw new FileForbiddenError();
      }

      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      const uploadKeyHash = createHash("sha256")
        .update(readIdempotencyKey(request), "utf8")
        .digest("hex")
        .slice(0, 24);
      const categoryHash = createHash("sha256")
        .update(category, "utf8")
        .digest("hex")
        .slice(0, 16);
      const extension = extensionFor(declaredType);
      const objectKey = `quarantine/users/${access.userId}/${categoryHash}/${contentSha256}-${uploadKeyHash}${extension}`;
      await options.storage.writeQuarantinedObject(objectKey, bytes, {
        contentType: declaredType,
        sha256: contentSha256,
        uploadedBy: access.userId,
      });

      const response = await executeCommand({
          actorScope: `user:${access.userId}`,
          command: "files.upload",
          database: options.database,
          payload: {
            category,
            contentSha256,
            contentType: declaredType,
            entityId,
            entityType,
            fileName,
            sizeBytes: bytes.length,
          },
          request,
          responseStatus: 201,
          run: async ({ transaction }) => {
            const inserted = await transaction.execute(
              `INSERT INTO file_objects (
                 object_key, file_name, content_type, size_bytes, category,
                 entity_type, entity_id, owner_user_id, factory_id, supplier_id,
                 \`sensitive\`, scan_status, content_sha256, retain_until, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 YEAR), CURRENT_TIMESTAMP(3))`,
              [objectKey, fileName, declaredType, bytes.length, category,
                entityType, entityId, access.userId, access.factoryId, access.supplierId,
                sensitive ? 1 : 0, contentSha256],
            );
            const fileId = inserted.insertId;
            if (fileId === undefined || fileId <= 0) throw new FilesUnavailableError();
            await createAuditWriter({ database: transaction })({
              access,
              action: "upload_quarantined",
              module: "files",
              entityType: "file",
              entityId: fileId,
              after: { category, fileName, sizeBytes: bytes.length, scanStatus: "quarantined" },
              request,
            });
            await enqueueOutbox(transaction, {
              topic: "file.scan",
              aggregateType: "file",
              aggregateId: String(fileId),
              deduplicationKey: `file:${fileId}:scan:${contentSha256}`,
              payload: { fileId, objectKey, contentSha256, contentType: declaredType },
            });
            return {
              file: { id: fileId, fileName, contentType: declaredType, sizeBytes: bytes.length, scanStatus: "quarantined" },
              usable: false,
            };
          },
        });
      return reply.status(response.statusCode).send(response.body);
    },
  );
}

function extensionFor(contentType: string): string {
  return new Map([
    ["application/pdf", ".pdf"],
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    ["application/vnd.ms-excel", ".xls"],
  ]).get(contentType) ?? "";
}

function matchesMagic(bytes: Uint8Array, contentType: string): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  switch (contentType) {
    case "application/pdf":
      return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return starts(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return starts(0x50, 0x4b, 0x03, 0x04);
    case "application/vnd.ms-excel":
      return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    default:
      return false;
  }
}
