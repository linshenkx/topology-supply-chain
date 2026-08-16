import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalFileStorage } from "../dist/infrastructure/local-file-storage.js";

test("local file storage keeps quarantined objects inside its root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "topology-local-files-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ root });
  const body = Buffer.from("%PDF-1.7\nlocal storage");
  const key = "quarantine/users/7/test/document.pdf";

  await storage.writeQuarantinedObject(key, body, {
    contentType: "application/pdf",
    sha256: createHash("sha256").update(body).digest("hex"),
    uploadedBy: 7,
  });
  assert.deepEqual(await storage.readObject(key), new Uint8Array(body));
  await storage.deleteObject(key);
  assert.equal(await storage.readObject(key), null);

  await assert.rejects(() => storage.readObject("../outside"), /object key rejected/u);
  await assert.rejects(() => storage.deleteObject("published/document.pdf"), /object key rejected/u);
  await assert.rejects(
    () => storage.writeQuarantinedObject(key, body, {
      contentType: "application/pdf",
      sha256: "0".repeat(64),
      uploadedBy: 7,
    }),
    /quarantined file rejected/u,
  );
});
