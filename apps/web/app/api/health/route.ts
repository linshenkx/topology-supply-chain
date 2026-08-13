import { isAliyunRuntime } from "../../lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();
  if (!isAliyunRuntime()) {
    return Response.json({
      status: "ok",
      runtime: "preview",
      checkedAt,
    });
  }
  const checks: Record<string, "ok" | "failed"> = {
    application: "ok",
    database: "failed",
    objectStorage: "failed",
  };
  try {
    const { checkMysqlConnection } = await import("@database/mysql");
    await checkMysqlConnection();
    checks.database = "ok";
  } catch {
    // Deliberately omit connection details and credentials.
  }
  try {
    const { checkOssConnection } = await import("../../lib/oss-store");
    await checkOssConnection();
    checks.objectStorage = "ok";
  } catch (error) {
    const value = error as {
      name?: string;
      code?: string;
      status?: number;
      message?: string;
      requestId?: string;
    };
    console.error("OSS health check failed", {
      name: value.name,
      code: value.code,
      status: value.status,
      message: value.message,
      requestId: value.requestId,
    });
    // Deliberately omit connection details and credentials from the response.
  }
  const healthy = Object.values(checks).every((value) => value === "ok");
  return Response.json(
    { status: healthy ? "ok" : "degraded", runtime: "aliyun", checks, checkedAt },
    { status: healthy ? 200 : 503 },
  );
}
