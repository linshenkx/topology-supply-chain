import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  output: process.env.DEPLOY_TARGET === "aliyun" ? "standalone" : undefined,
  outputFileTracingRoot: repositoryRoot,
  serverExternalPackages: ["ali-oss"],
  env: {
    DEPLOY_TARGET: process.env.DEPLOY_TARGET,
  },
};

export default nextConfig;
