import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.DEPLOY_TARGET === "aliyun" ? "standalone" : undefined,
  serverExternalPackages: ["ali-oss"],
  env: {
    DEPLOY_TARGET: process.env.DEPLOY_TARGET,
  },
};

export default nextConfig;
