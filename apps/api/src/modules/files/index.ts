import {
  apiErrorSchemaId,
  fileDownloadQuerySchema,
  fileDownloadResponseSchema,
  type FileDownloadQuery,
} from "@topology/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QueryExecutor } from "../../infrastructure/database.js";
import type { AccessContext } from "../auth/index.js";

const INTERNAL_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "company_qc",
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
  sensitive,
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
  readObject(objectKey: string): Promise<Uint8Array | null>;
}

export interface FilesModuleOptions {
  audit: (event: FileDownloadAuditEvent) => Promise<void> | void;
  authenticate: (request: FastifyRequest) => Promise<FilesAccessContext>;
  database?: QueryExecutor;
  storage?: FileStoragePort;
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
}
