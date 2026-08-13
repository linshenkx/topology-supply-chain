export function runtimeEnv(name: string) {
  return process.env[name]?.trim();
}

export function isAliyunRuntime() {
  return runtimeEnv("DEPLOY_TARGET") === "aliyun";
}
