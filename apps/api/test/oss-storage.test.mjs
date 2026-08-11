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

test("RAM role storage caches IMDSv2 tokens and uses bounded STS refresh", async () => {
  const requests = [];
  const sdkConfigs = [];
  let credentialVersion = 0;
  const storage = createOssFileStorage({
    env: {
      OSS_REGION: "oss-cn-guangzhou",
      OSS_BUCKET: "topology-private",
      OSS_ECS_RAM_ROLE: "topology api/role",
      OSS_INTERNAL_ENDPOINT: "true",
    },
    fetchImplementation: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/latest/api/token")) {
        return new Response("metadata-token");
      }
      credentialVersion += 1;
      return Response.json({
        Code: "Success",
        AccessKeyId: `temporary-id-${credentialVersion}`,
        AccessKeySecret: `temporary-secret-${credentialVersion}`,
        SecurityToken: `security-token-${credentialVersion}`,
      });
    },
    sdkClientFactory: (config) => {
      sdkConfigs.push(config);
      return {
        async get() {
          return { content: new Uint8Array([9, 8, 7]) };
        },
      };
    },
  });

  assert.deepEqual(await storage.readObject("files/one"), new Uint8Array([9, 8, 7]));
  assert.deepEqual(await storage.readObject("files/two"), new Uint8Array([9, 8, 7]));
  assert.equal(requests.length, 2, "ordinary reads must reuse the OSS client");
  assert.match(requests[0].url, /\/latest\/api\/token$/u);
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(
    requests[0].init.headers["X-aliyun-ecs-metadata-token-ttl-seconds"],
    "21600",
  );
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.match(
    requests[1].url,
    /\/security-credentials\/topology%20api%2Frole$/u,
  );
  assert.equal(
    requests[1].init.headers["X-aliyun-ecs-metadata-token"],
    "metadata-token",
  );
  assert.ok(requests[1].init.signal instanceof AbortSignal);

  assert.equal(sdkConfigs.length, 1);
  const sdkConfig = sdkConfigs[0];
  assert.equal(sdkConfig.secure, true);
  assert.equal(sdkConfig.internal, true);
  assert.equal(sdkConfig.timeout, 30_000);
  assert.equal(sdkConfig.refreshSTSTokenInterval, 5 * 60_000);
  assert.equal(typeof sdkConfig.refreshSTSToken, "function");
  assert.deepEqual(
    await Promise.all([
      sdkConfig.refreshSTSToken(),
      sdkConfig.refreshSTSToken(),
    ]),
    [
      {
        accessKeyId: "temporary-id-2",
        accessKeySecret: "temporary-secret-2",
        stsToken: "security-token-2",
      },
      {
        accessKeyId: "temporary-id-2",
        accessKeySecret: "temporary-secret-2",
        stsToken: "security-token-2",
      },
    ],
  );
  assert.equal(
    requests.filter(({ url }) => url.endsWith("/latest/api/token")).length,
    1,
    "STS refresh must reuse the unexpired IMDSv2 token",
  );
  assert.equal(requests.length, 3);
});

test("temporary IMDS initialization failures are sanitized and retryable", async () => {
  let tokenAttempts = 0;
  const storage = createOssFileStorage({
    env: {
      OSS_REGION: "oss-cn-guangzhou",
      OSS_BUCKET: "topology-private",
      OSS_ECS_RAM_ROLE: "topology-api-role",
    },
    fetchImplementation: async (input) => {
      if (String(input).endsWith("/latest/api/token")) {
        tokenAttempts += 1;
        return tokenAttempts === 1
          ? new Response("secret IMDS failure", { status: 503 })
          : new Response("metadata-token");
      }
      return Response.json({
        Code: "Success",
        AccessKeyId: "temporary-id",
        AccessKeySecret: "temporary-secret",
        SecurityToken: "security-token",
      });
    },
    sdkClientFactory: () => ({
      async get() {
        return { content: new Uint8Array([1]) };
      },
    }),
  });

  await assert.rejects(
    () => storage.readObject("files/secret-name"),
    (error) =>
      error instanceof OssStorageUnavailableError &&
      error.message === "Object storage unavailable" &&
      error.cause === undefined,
  );
  assert.deepEqual(await storage.readObject("files/retry"), new Uint8Array([1]));
  assert.equal(tokenAttempts, 2);
});
