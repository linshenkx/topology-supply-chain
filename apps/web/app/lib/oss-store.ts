import OSS from "ali-oss";

declare global {
  var topologyOssClientPromise: Promise<OSS> | undefined;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`生产环境缺少${name}配置。`);
  return value;
}

export type EcsRamRoleCredential = {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
};

export async function getEcsRamRoleCredential(roleName: string): Promise<EcsRamRoleCredential> {
  const tokenResponse = await fetch("http://100.100.100.200/latest/api/token", {
    method: "PUT",
    headers: {
      "X-aliyun-ecs-metadata-token-ttl-seconds": "21600",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) {
    throw new Error(`ECS IMDSv2 token request failed (${tokenResponse.status}).`);
  }
  const metadataToken = await tokenResponse.text();
  const credentialResponse = await fetch(
    `http://100.100.100.200/latest/meta-data/ram/security-credentials/${encodeURIComponent(roleName)}`,
    {
      headers: {
        "X-aliyun-ecs-metadata-token": metadataToken,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!credentialResponse.ok) {
    throw new Error(`ECS RAM role credential request failed (${credentialResponse.status}).`);
  }
  const value = await credentialResponse.json() as {
    Code?: string;
    AccessKeyId?: string;
    AccessKeySecret?: string;
    SecurityToken?: string;
  };
  if (
    value.Code !== "Success" ||
    !value.AccessKeyId ||
    !value.AccessKeySecret ||
    !value.SecurityToken
  ) {
    throw new Error("ECS RAM role returned an invalid temporary credential.");
  }
  return {
    accessKeyId: value.AccessKeyId,
    accessKeySecret: value.AccessKeySecret,
    securityToken: value.SecurityToken,
  };
}

async function createOssClient() {
  const roleName = process.env.OSS_ECS_RAM_ROLE?.trim();
  if (roleName) {
    const credential = await getEcsRamRoleCredential(roleName);
    return new OSS({
      region: required("OSS_REGION"),
      bucket: required("OSS_BUCKET"),
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken,
      refreshSTSTokenInterval: 0,
      refreshSTSToken: async () => {
        const refreshed = await getEcsRamRoleCredential(roleName);
        return {
          accessKeyId: refreshed.accessKeyId,
          accessKeySecret: refreshed.accessKeySecret,
          stsToken: refreshed.securityToken,
        };
      },
      secure: true,
      internal: process.env.OSS_INTERNAL_ENDPOINT === "true",
      timeout: 60_000,
    });
  }
  return new OSS({
    region: required("OSS_REGION"),
    bucket: required("OSS_BUCKET"),
    accessKeyId: required("OSS_ACCESS_KEY_ID"),
    accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
    secure: true,
    internal: process.env.OSS_INTERNAL_ENDPOINT === "true",
    timeout: 60_000,
  });
}

export function getOssClient() {
  globalThis.topologyOssClientPromise ??= createOssClient();
  return globalThis.topologyOssClientPromise;
}

export async function putPrivateObject(input: {
  objectKey: string;
  body: Buffer | Uint8Array;
  contentType: string;
  originalName: string;
  uploadedBy: number;
}) {
  const client = await getOssClient();
  await client.put(input.objectKey, Buffer.from(input.body), {
    headers: {
      "content-type": input.contentType,
      "x-oss-object-acl": "private",
      "x-oss-meta-original-name": encodeURIComponent(input.originalName),
      "x-oss-meta-uploaded-by": String(input.uploadedBy),
    },
  });
  return { objectKey: input.objectKey };
}

export async function getPrivateObject(objectKey: string) {
  const client = await getOssClient();
  const result = await client.get(objectKey);
  return {
    body: Buffer.isBuffer(result.content)
      ? result.content
      : Buffer.from(result.content as ArrayBuffer),
    contentType: String(
      (result.res.headers as Record<string, string | undefined>)["content-type"] ??
      "application/octet-stream",
    ),
  };
}

export async function createPrivateDownloadUrl(objectKey: string, expiresSeconds = 300) {
  const client = await getOssClient();
  return client.signatureUrl(objectKey, {
    expires: Math.min(Math.max(expiresSeconds, 60), 900),
    method: "GET",
  });
}

export async function checkOssConnection() {
  const client = await getOssClient();
  const result = await client.getBucketInfo(required("OSS_BUCKET"));
  return {
    bucket: result.bucket.Name,
    region: result.bucket.Location,
  };
}
