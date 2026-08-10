import { processDueReminders } from "../../../lib/reminders";
import { runtimeEnv } from "../../../lib/runtime-env";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const localPreview = ["localhost", "127.0.0.1"].includes(url.hostname);
  const token = request.headers.get("x-topology-job-token");
  const jobToken = runtimeEnv("JOB_TOKEN");
  if (!localPreview && (!jobToken || token !== jobToken)) {
    return Response.json({ error: "后台任务认证失败。" }, { status: 401 });
  }
  try {
    return Response.json(await processDueReminders());
  } catch (error) {
    const message = error instanceof Error ? error.message : "提醒任务执行失败。";
    return Response.json({ error: message }, { status: 500 });
  }
}
