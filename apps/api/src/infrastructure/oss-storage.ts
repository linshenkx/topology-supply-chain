import OSS from "ali-oss";

const IMDS_ORIGIN = "http://100.100.100.200";
const IMDS_TIMEOUT_MS = 10_000;
const OSS_TIMEOUT_MS = 30_000;

export interface OssEnvironment {
  OSS_ACCESS_KEY_ID?: string;
  OSS_ACCESS_KEY_SECRET?: string;
  OSS_BUCKET?: string;
  OSS_ECS_RAM_ROLE?: string;
  OSS_INTERNAL_ENDPOINT?: string;
  OSS_REGION?: string;
}

interface OssClient {
  get(objectKey: string): Promise<{ content?: unknown }>;
}

interface OssResolvedConfig {
  accessKeyId?: string;
  accessKeySecret?: string;
  bucket: string;
  internal: boolean;
  region: string;
  roleName?: string;
}

interface TemporaryCredential {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
}

export interface OssFileStorageOptions {
  clientFactory?: (config: OssResolvedConfig) => Promise<OssClient> | OssClient;
  env?: OssEnvironment;
  fetchImplementation?: typeof fetch;
}

export interface OssFileStorage {
  readObject(objectKey: string): Promise<Uint8Array | null>;
}

export class OssStorageUnavailableError extends Error {
  constructor() {
    super("Object storage unavailable");
    this.name = "OssStorageUnavailableError";
  }
}

function unavailable(): never {
  throw new OssStorageUnavailableError();
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function readConfig(environment: OssEnvironment): OssResolvedConfig {
  const region = optional(environment.OSS_REGION);
  const bucket = optional(environment.OSS_BUCKET);
  const roleName = optional(environment.OSS_ECS_RAM_ROLE);
  const accessKeyId = optional(environment.OSS_ACCESS_KEY_ID);
  const accessKeySecret = optional(environment.OSS_ACCESS_KEY_SECRET);

  if (
    region === undefined ||
    bucket === undefined ||
    (roleName === undefined &&
      (accessKeyId === undefined || accessKeySecret === undefined))
  ) {
    return unavailable();
  }

  return {
    region,
    bucket,
    internal: environment.OSS_INTERNAL_ENDPOINT === "true",
    ...(roleName === undefined ? {} : { roleName }),
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    ...(accessKeySecret === undefined ? {} : { accessKeySecret }),
  };
}

async function temporaryCredential(
  roleName: string,
  fetchImplementation: typeof fetch,
): Promise<TemporaryCredential> {
  try {
    const tokenResponse = await fetchImplementation(
      `${IMDS_ORIGIN}/latest/api/token`,
      {
        method: "PUT",
        headers: { "X-aliyun-ecs-metadata-token-ttl-seconds": "21600" },
        signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
      },
    );
    if (!tokenResponse.ok) return unavailable();
    const token = await tokenResponse.text();
    if (token.length === 0) return unavailable();

    const credentialResponse = await fetchImplementation(
      `${IMDS_ORIGIN}/latest/meta-data/ram/security-credentials/${encodeURIComponent(roleName)}`,
      {
        headers: { "X-aliyun-ecs-metadata-token": token },
        signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
      },
    );
    if (!credentialResponse.ok) return unavailable();
    const value = (await credentialResponse.json()) as Record<string, unknown>;
    if (
      value.Code !== "Success" ||
      typeof value.AccessKeyId !== "string" ||
      typeof value.AccessKeySecret !== "string" ||
      typeof value.SecurityToken !== "string"
    ) {
      return unavailable();
    }
    return {
      accessKeyId: value.AccessKeyId,
      accessKeySecret: value.AccessKeySecret,
      securityToken: value.SecurityToken,
    };
  } catch (error) {
    if (error instanceof OssStorageUnavailableError) throw error;
    throw new OssStorageUnavailableError();
  }
}

async function defaultClient(
  config: OssResolvedConfig,
  fetchImplementation: typeof fetch,
): Promise<OssClient> {
  if (config.roleName !== undefined) {
    const credential = await temporaryCredential(
      config.roleName,
      fetchImplementation,
    );
    return new OSS({
      region: config.region,
      bucket: config.bucket,
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken,
      internal: config.internal,
      secure: true,
      timeout: OSS_TIMEOUT_MS,
      refreshSTSTokenInterval: 0,
      refreshSTSToken: async () => {
        const refreshed = await temporaryCredential(
          config.roleName!,
          fetchImplementation,
        );
        return {
          accessKeyId: refreshed.accessKeyId,
          accessKeySecret: refreshed.accessKeySecret,
          stsToken: refreshed.securityToken,
        };
      },
    });
  }

  return new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId!,
    accessKeySecret: config.accessKeySecret!,
    internal: config.internal,
    secure: true,
    timeout: OSS_TIMEOUT_MS,
  });
}

function missingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return (
    value.code === "NoSuchKey" ||
    value.status === 404 ||
    value.statusCode === 404
  );
}

function bytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return Uint8Array.from(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return unavailable();
}

export function createOssFileStorage(
  options: OssFileStorageOptions = {},
): OssFileStorage {
  const environment = options.env ?? process.env;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let clientPromise: Promise<OssClient> | undefined;

  const client = () => {
    clientPromise ??= (async () => {
      const config = readConfig(environment);
      return options.clientFactory === undefined
        ? defaultClient(config, fetchImplementation)
        : options.clientFactory(config);
    })();
    return clientPromise;
  };

  return {
    async readObject(objectKey) {
      if (objectKey.length === 0 || objectKey.length > 1_024) {
        return unavailable();
      }
      try {
        const result = await (await client()).get(objectKey);
        return bytes(result.content);
      } catch (error) {
        if (missingObject(error)) return null;
        if (error instanceof OssStorageUnavailableError) throw error;
        throw new OssStorageUnavailableError();
      }
    },
  };
}
