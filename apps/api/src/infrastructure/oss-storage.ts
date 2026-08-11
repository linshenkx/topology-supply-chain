import OSS from "ali-oss";

const IMDS_ORIGIN = "http://100.100.100.200";
const IMDS_TIMEOUT_MS = 10_000;
const IMDS_TOKEN_TTL_SECONDS = 21_600;
const IMDS_TOKEN_REFRESH_SKEW_MS = 60_000;
const OSS_TIMEOUT_MS = 30_000;
const OSS_STS_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_METADATA_VALUE_CHARACTERS = 16_384;

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

interface OssSdkConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  internal: boolean;
  refreshSTSToken?: () => Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    stsToken: string;
  }>;
  refreshSTSTokenInterval?: number;
  region: string;
  secure: true;
  stsToken?: string;
  timeout: number;
}

export interface OssFileStorageOptions {
  clientFactory?: (config: OssResolvedConfig) => Promise<OssClient> | OssClient;
  env?: OssEnvironment;
  fetchImplementation?: typeof fetch;
  sdkClientFactory?: (config: OssSdkConfig) => Promise<OssClient> | OssClient;
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

function nonEmptyMetadataValue(value: unknown): string {
  if (typeof value !== "string") return unavailable();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_METADATA_VALUE_CHARACTERS
  ) {
    return unavailable();
  }
  return normalized;
}

function metadataTokenProvider(fetchImplementation: typeof fetch) {
  let token: string | undefined;
  let expiresAt = 0;
  let pending: Promise<string> | undefined;

  return async (): Promise<string> => {
    if (
      token !== undefined &&
      Date.now() < expiresAt - IMDS_TOKEN_REFRESH_SKEW_MS
    ) {
      return token;
    }
    if (pending !== undefined) return pending;

    const request = (async () => {
      try {
        const response = await fetchImplementation(
          `${IMDS_ORIGIN}/latest/api/token`,
          {
            method: "PUT",
            headers: {
              "X-aliyun-ecs-metadata-token-ttl-seconds": String(
                IMDS_TOKEN_TTL_SECONDS,
              ),
            },
            signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
          },
        );
        if (!response.ok) return unavailable();
        const value = nonEmptyMetadataValue(await response.text());
        token = value;
        expiresAt = Date.now() + IMDS_TOKEN_TTL_SECONDS * 1_000;
        return value;
      } catch (error) {
        if (error instanceof OssStorageUnavailableError) throw error;
        throw new OssStorageUnavailableError();
      }
    })();
    pending = request;
    try {
      return await request;
    } finally {
      if (pending === request) pending = undefined;
    }
  };
}

async function temporaryCredential(
  roleName: string,
  fetchImplementation: typeof fetch,
  metadataToken: () => Promise<string>,
): Promise<TemporaryCredential> {
  try {
    const token = await metadataToken();

    const credentialResponse = await fetchImplementation(
      `${IMDS_ORIGIN}/latest/meta-data/ram/security-credentials/${encodeURIComponent(roleName)}`,
      {
        headers: { "X-aliyun-ecs-metadata-token": token },
        signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
      },
    );
    if (!credentialResponse.ok) return unavailable();
    const value = (await credentialResponse.json()) as Record<string, unknown>;
    if (value.Code !== "Success") return unavailable();
    return {
      accessKeyId: nonEmptyMetadataValue(value.AccessKeyId),
      accessKeySecret: nonEmptyMetadataValue(value.AccessKeySecret),
      securityToken: nonEmptyMetadataValue(value.SecurityToken),
    };
  } catch (error) {
    if (error instanceof OssStorageUnavailableError) throw error;
    throw new OssStorageUnavailableError();
  }
}

function temporaryCredentialProvider(
  roleName: string,
  fetchImplementation: typeof fetch,
): () => Promise<TemporaryCredential> {
  const metadataToken = metadataTokenProvider(fetchImplementation);
  let pending: Promise<TemporaryCredential> | undefined;

  return async () => {
    if (pending !== undefined) return pending;
    const request = temporaryCredential(
      roleName,
      fetchImplementation,
      metadataToken,
    );
    pending = request;
    try {
      return await request;
    } finally {
      if (pending === request) pending = undefined;
    }
  };
}

async function defaultClient(
  config: OssResolvedConfig,
  fetchImplementation: typeof fetch,
  sdkClientFactory: (config: OssSdkConfig) => Promise<OssClient> | OssClient,
): Promise<OssClient> {
  if (config.roleName !== undefined) {
    const credentialProvider = temporaryCredentialProvider(
      config.roleName,
      fetchImplementation,
    );
    const credential = await credentialProvider();
    return sdkClientFactory({
      region: config.region,
      bucket: config.bucket,
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken,
      internal: config.internal,
      secure: true,
      timeout: OSS_TIMEOUT_MS,
      refreshSTSTokenInterval: OSS_STS_REFRESH_INTERVAL_MS,
      refreshSTSToken: async () => {
        const refreshed = await credentialProvider();
        return {
          accessKeyId: refreshed.accessKeyId,
          accessKeySecret: refreshed.accessKeySecret,
          stsToken: refreshed.securityToken,
        };
      },
    });
  }

  return sdkClientFactory({
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
  const environment = options.env ?? (process.env as OssEnvironment);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const sdkClientFactory =
    options.sdkClientFactory ?? ((config: OssSdkConfig) => new OSS(config));
  let clientPromise: Promise<OssClient> | undefined;

  const client = () => {
    if (clientPromise !== undefined) return clientPromise;
    const pending = (async () => {
      const config = readConfig(environment);
      return options.clientFactory === undefined
        ? defaultClient(config, fetchImplementation, sdkClientFactory)
        : options.clientFactory(config);
    })();
    clientPromise = pending;
    void pending.catch(() => {
      if (clientPromise === pending) clientPromise = undefined;
    });
    return pending;
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
