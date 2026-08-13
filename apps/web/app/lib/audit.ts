import { getDb } from "@database/index";
import { auditLogs } from "@database/schema";
import type { AccessContext } from "./authz";

export async function writeAudit(
  access: AccessContext,
  input: {
    action: string;
    module: string;
    entityType: string;
    entityId: string | number;
    businessNo?: string;
    before?: unknown;
    after?: unknown;
    sensitiveView?: boolean;
    exported?: boolean;
    request?: Request;
  },
) {
  if (access.localPreview) return;
  const archiveAfter = new Date();
  archiveAfter.setFullYear(archiveAfter.getFullYear() + 5);
  await getDb().insert(auditLogs).values({
    actorUserId: access.userId,
    action: input.action,
    module: input.module,
    entityType: input.entityType,
    entityId: String(input.entityId),
    businessNo: input.businessNo,
    beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
    afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    ipAddress: input.request?.headers.get("cf-connecting-ip") ?? null,
    deviceId: input.request?.headers.get("x-topology-device-id") ?? null,
    sensitiveView: input.sensitiveView ?? false,
    exported: input.exported ?? false,
    archiveAfter: archiveAfter.toISOString(),
  });
}
