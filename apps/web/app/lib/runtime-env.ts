import {
  isAliyunRuntime,
  runtimeEnv,
} from "@topology/shared-config/runtime-env";

export { isAliyunRuntime, runtimeEnv };

export function requireRuntimeEnv(name: string) {
  const value = runtimeEnv(name);
  if (!value) throw new Error(`生产环境缺少${name}配置。`);
  return value;
}

export async function getPreviewFileBucket() {
  if (isAliyunRuntime()) throw new Error("阿里云运行环境不能访问预览存储。");
  const workers = await import("cloudflare:workers") as { env?: { FILES?: unknown } };
  if (!workers.env?.FILES) throw new Error("预览文件存储绑定不可用。");
  return workers.env.FILES;
}
