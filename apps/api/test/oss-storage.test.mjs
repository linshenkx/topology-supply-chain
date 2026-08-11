import assert from "node:assert/strict";
import test from "node:test";

import {
  OssStorageUnavailableError,
  createOssFileStorage,
} from "../dist/infrastructure/oss-storage.js";

const directEnvironment = {
  OSS_REGION: "oss-cn-guangzhou",
  OSS_BUCKET: "topology-private",
  OSS_ACCESS_KEY_ID: "test-id",
  OSS_ACCESS_KEY_SECRET: "test-secret",
  OSS_INTERNAL_ENDPOINT: "true",
};

test("OSS storage is lazy and reads bytes through a fixed configuration", async () => {
  const configs = [];
  const keys = [];
  const storage = createOssFileStorage({
    env: directEnvironment,
    clientFactory: (config) => {
      configs.push(config);
      return {
        async get(key) {
          keys.push(key);
          return { content: Buffer.from("private-file") };
        },
      };
    },
  });

  assert.equal(configs.length, 0);
  assert.deepEqual(
    await storage.readObject("invoice/2026/file.pdf"),
    Uint8Array.from(Buffer.from("private-file")),
  );
  assert.deepEqual(keys, ["invoice/2026/file.pdf"]);
  assert.deepEqual(configs, [
    {
      accessKeyId: "test-id",
      accessKeySecret: "test-secret",
      bucket: "topology-private",
      internal: true,
      region: "oss-cn-guangzhou",
    },
  ]);
});

test("OSS storage maps missing objects to null and sanitizes all other failures", async () => {
  const missing = createOssFileStorage({
    env: directEnvironment,
    clientFactory: () => ({
      async get() {
        throw { code: "NoSuchKey", objectKey: "must-not-leak.pdf" };
      },
    }),
  });
  assert.equal(await missing.readObject("missing.pdf"), null);

  for (const storage of [
    createOssFileStorage({ env: {} }),
    createOssFileStorage({
      env: directEnvironment,
      clientFactory: () => ({
        async get() {
          throw new Error("test-secret must-not-leak.pdf");
        },
      }),
    }),
    createOssFileStorage({
      env: directEnvironment,
      clientFactory: () => ({ async get() { return { content: "invalid" }; } }),
    }),
  ]) {
    await assert.rejects(
      () => storage.readObject("invoice/file.pdf"),
      (error) => {
        assert.ok(error instanceof OssStorageUnavailableError);
        assert.doesNotMatch(error.message, /secret|file\.pdf|OSS_/iu);
        return true;
      },
    );
  }
});

test("OSS storage accepts RAM role configuration without direct credentials", async () => {
  const configs = [];
  const storage = createOssFileStorage({
    env: {
      OSS_REGION: "oss-cn-guangzhou",
      OSS_BUCKET: "topology-private",
      OSS_ECS_RAM_ROLE: "topology-api-role",
    },
    clientFactory: (config) => {
      configs.push(config);
      return { async get() { return { content: new Uint8Array([1, 2]) }; } };
    },
  });

  assert.deepEqual(await storage.readObject("files/one"), new Uint8Array([1, 2]));
  assert.deepEqual(configs, [
    {
      bucket: "topology-private",
      internal: false,
      region: "oss-cn-guangzhou",
      roleName: "topology-api-role",
    },
  ]);
});
