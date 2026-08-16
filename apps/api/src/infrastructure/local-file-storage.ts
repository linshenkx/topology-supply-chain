import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_FILE_SIZE_BYTES = 20 * 1_024 * 1_024;

interface LocalFileStorageOptions {
  root: string;
}

interface LocalFileStorage {
  deleteObject(objectKey: string): Promise<void>;
  readObject(objectKey: string): Promise<Uint8Array | null>;
  writeQuarantinedObject(
    objectKey: string,
    body: Uint8Array,
    metadata: { contentType: string; sha256: string; uploadedBy: number },
  ): Promise<void>;
}

function objectPath(root: string, objectKey: string): string {
  if (
    objectKey.length === 0 ||
    objectKey.length > 1_024 ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Local file object key rejected");
  }
  const target = resolve(root, ...objectKey.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Local file object key rejected");
  }
  return target;
}

export function createLocalFileStorage(
  options: LocalFileStorageOptions,
): LocalFileStorage {
  const root = resolve(options.root.trim());
  if (options.root.trim().length === 0) {
    throw new Error("Local file storage root is required");
  }

  return {
    async deleteObject(objectKey) {
      if (!objectKey.startsWith("quarantine/")) {
        throw new Error("Local file object key rejected");
      }
      await rm(objectPath(root, objectKey), { force: true });
    },
    async readObject(objectKey) {
      const target = objectPath(root, objectKey);
      try {
        const file = await stat(target);
        if (!file.isFile() || file.size > MAX_FILE_SIZE_BYTES) {
          throw new Error("Local file object is invalid");
        }
        return new Uint8Array(await readFile(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeQuarantinedObject(objectKey, body, metadata) {
      if (
        !objectKey.startsWith("quarantine/") ||
        body.length === 0 ||
        body.length > MAX_FILE_SIZE_BYTES ||
        createHash("sha256").update(body).digest("hex") !== metadata.sha256 ||
        metadata.contentType.trim().length === 0 ||
        !Number.isSafeInteger(metadata.uploadedBy) ||
        metadata.uploadedBy <= 0
      ) {
        throw new Error("Local quarantined file rejected");
      }
      const target = objectPath(root, objectKey);
      await mkdir(resolve(target, ".."), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
