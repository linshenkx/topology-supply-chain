export function runtimeEnv(name: string) {
  return process.env[name]?.trim();
}

export function requireRuntimeEnv(name: string) {
  const value = runtimeEnv(name);
  if (!value) throw new Error(`生产环境缺少${name}配置。`);
  return value;
}

export function isAliyunRuntime() {
  return runtimeEnv("DEPLOY_TARGET") === "aliyun";
}

export async function getPreviewFileBucket() {
  if (isAliyunRuntime()) throw new Error("阿里云运行环境不能访问预览存储。");
  const moduleName = "cloudflare:workers";
  const workers = await import(moduleName) as { env?: { FILES?: any } };
  if (!workers.env?.FILES) throw new Error("预览文件存储绑定不可用。");
  return workers.env.FILES;
}
