type LocalPreviewInput = {
  requestUrl: string;
  appEnv?: string;
  deployTarget?: string;
  nodeEnv?: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalized(value?: string) {
  return value?.trim().toLowerCase();
}

/**
 * Local preview is an unauthenticated admin-shaped demo identity. It must never
 * be enabled by a client-controlled Host header in a production runtime.
 */
export function isLocalPreviewRequest(input: LocalPreviewInput) {
  if (
    normalized(input.appEnv) === "production" ||
    normalized(input.deployTarget) === "aliyun" ||
    normalized(input.nodeEnv) === "production"
  ) {
    return false;
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(input.requestUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}
