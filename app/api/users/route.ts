import { and, asc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { insertOne } from "../../../db/insert-one";
import { approvalRequests, authCredentials, authSessions, userRoles, users } from "../../../db/schema";
import { withDbTransaction } from "../../../db/transaction";
import { accessErrorResponse, requireAccess, requireRole } from "../../lib/authz";
import { writeAudit } from "../../lib/audit";

const ASSIGNABLE_ROLES = new Set([
  "admin",
  "supply_chain",
  "finance",
  "factory",
  "supplier_qc",
  "company_qc",
  "receiver",
]);

function maskMobile(mobile: string) {
  return mobile.length === 11 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : "";
}

export async function GET(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin"]);
    if (access.localPreview) return Response.json({ users: [], preview: true });

    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    await db.update(userRoles)
      .set({ status: "expired", updatedAt: new Date().toISOString() })
      .where(and(
        eq(userRoles.status, "active"),
        isNotNull(userRoles.effectiveTo),
        lt(userRoles.effectiveTo, today),
      ));
    const [allUsers, allRoles] = await Promise.all([
      db.select().from(users).orderBy(asc(users.name)),
      db.select().from(userRoles),
    ]);
    const roleMap = new Map<number, string[]>();
    const assignmentMap = new Map<number, typeof allRoles>();
    for (const row of allRoles) {
      assignmentMap.set(row.userId, [...(assignmentMap.get(row.userId) ?? []), row]);
      if (row.status !== "active") continue;
      roleMap.set(row.userId, [...(roleMap.get(row.userId) ?? []), row.roleCode]);
    }
    const result = allUsers.map((user) => ({
      id: user.id,
      email: user.email,
      mobile: maskMobile(user.mobile),
      name: user.name,
      accountStatus: user.accountStatus,
      organizationName: user.organizationName,
      factoryId: user.factoryId,
      supplierId: user.supplierId,
      roles: Array.from(new Set([user.role, ...(roleMap.get(user.id) ?? [])])),
      roleAssignments: (assignmentMap.get(user.id) ?? []).map((row) => ({
        id: row.id,
        roleCode: row.roleCode,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        status: row.status,
        requestedBy: row.requestedBy,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
      })),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
    await writeAudit(access, {
      action: "view",
      module: "identity",
      entityType: "user_list",
      entityId: "all",
      sensitiveView: true,
      request,
    });
    return Response.json({ users: result });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin"]);
    if (access.localPreview) return Response.json({ success: true, preview: true });

    const body = await request.json() as {
      userId?: number;
      roleCode?: string;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      reason?: string;
    };
    const roleCode = body.roleCode?.trim() ?? "";
    const effectiveFrom = body.effectiveFrom?.trim() ?? "";
    const effectiveTo = body.effectiveTo?.trim() || null;
    const reason = body.reason?.trim() ?? "";
    if (!Number.isInteger(body.userId) || !ASSIGNABLE_ROLES.has(roleCode)) {
      return Response.json({ error: "请选择用户和允许分配的岗位角色。" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || (effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo))) {
      return Response.json({ error: "权限生效日期格式不正确。" }, { status: 400 });
    }
    if (!reason) return Response.json({ error: "角色变更必须填写申请原因。" }, { status: 400 });
    const start = new Date(`${effectiveFrom}T00:00:00+08:00`);
    const end = effectiveTo ? new Date(`${effectiveTo}T23:59:59+08:00`) : null;
    if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime())) || (end && end < start)) {
      return Response.json({ error: "权限有效期不正确。" }, { status: 400 });
    }
    if (end && end.getTime() - start.getTime() > 90 * 86400000) {
      return Response.json({ error: "临时权限最长只能授予90天。" }, { status: 400 });
    }

    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, body.userId!)).limit(1);
    if (!target) return Response.json({ error: "账号不存在。" }, { status: 404 });
    if (target.accountStatus === "disabled") {
      return Response.json({ error: "已停用账号不能新增角色。" }, { status: 409 });
    }
    const existing = await db.select().from(userRoles).where(and(
      eq(userRoles.userId, target.id),
      eq(userRoles.roleCode, roleCode),
      or(eq(userRoles.status, "pending"), eq(userRoles.status, "active")),
    )).limit(1);
    if (existing.length || target.role === roleCode) {
      return Response.json({ error: "该用户已经拥有此角色，或已有待审核申请。" }, { status: 409 });
    }

    const now = new Date().toISOString();
    let roleRequestId = 0;
    let approvalId = 0;
    await withDbTransaction(db, async (tx) => {
      const insertedRole = await insertOne(
        tx.insert(userRoles).values({
        userId: target.id,
        roleCode,
        effectiveFrom,
        effectiveTo,
        status: "pending",
        requestedBy: access.userId,
        createdAt: now,
        updatedAt: now,
        }),
        id => tx.select().from(userRoles).where(eq(userRoles.id, id)).limit(1),
      );
      roleRequestId = Number(insertedRole.id);
      const insertedApproval = await insertOne(
        tx.insert(approvalRequests).values({
        requestNo: `AP-ROLE-${Date.now()}-${roleRequestId}`,
        workflowType: "user_role_change",
        entityType: "user_role",
        entityId: roleRequestId,
        summary: `为${target.name}新增角色：${roleCode}`,
        payloadJson: JSON.stringify({ userId: target.id, roleCode, effectiveFrom, effectiveTo, reason }),
        highRisk: true,
        status: "pending",
        requestedBy: access.userId,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
        }),
        id => tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1),
      );
      approvalId = Number(insertedApproval.id);
    });
    await writeAudit(access, {
      action: "request_role_change",
      module: "identity",
      entityType: "user_role",
      entityId: String(roleRequestId),
      businessNo: target.email,
      after: { roleCode, effectiveFrom, effectiveTo, approvalId, reason },
      request,
    });
    return Response.json({ success: true, roleRequestId, approvalId, status: "pending" }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin"]);
    if (access.localPreview) return Response.json({ success: true, preview: true });

    const body = await request.json() as { roleAssignmentId?: number; reason?: string };
    const reason = body.reason?.trim() ?? "";
    if (!Number.isInteger(body.roleAssignmentId) || !reason) {
      return Response.json({ error: "撤销角色必须选择角色记录并填写原因。" }, { status: 400 });
    }
    const db = getDb();
    const [roleAssignment] = await db.select().from(userRoles)
      .where(eq(userRoles.id, body.roleAssignmentId!))
      .limit(1);
    if (!roleAssignment) return Response.json({ error: "角色记录不存在。" }, { status: 404 });
    if (roleAssignment.status !== "active") {
      return Response.json({ error: "只有生效中的附加角色可以申请撤销。" }, { status: 409 });
    }
    const [target] = await db.select().from(users).where(eq(users.id, roleAssignment.userId)).limit(1);
    if (!target) return Response.json({ error: "角色所属账号不存在。" }, { status: 404 });
    const pendingApprovals = await db.select().from(approvalRequests).where(and(
      eq(approvalRequests.workflowType, "user_role_change"),
      eq(approvalRequests.entityId, roleAssignment.id),
      eq(approvalRequests.status, "pending"),
    )).limit(1);
    if (pendingApprovals.length) {
      return Response.json({ error: "该角色已有待审核的变更申请。" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const approval = await insertOne(
      db.insert(approvalRequests).values({
        requestNo: `AP-ROLE-REVOKE-${Date.now()}-${roleAssignment.id}`,
        workflowType: "user_role_change",
        entityType: "user_role",
        entityId: roleAssignment.id,
        summary: `撤销 ${target.name} 的角色：${roleAssignment.roleCode}`,
        payloadJson: JSON.stringify({
          operation: "revoke",
          userId: target.id,
          roleCode: roleAssignment.roleCode,
          reason,
        }),
        highRisk: true,
        status: "pending",
        requestedBy: access.userId,
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      id => db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1),
    );
    await writeAudit(access, {
      action: "request_role_revocation",
      module: "identity",
      entityType: "user_role",
      entityId: String(roleAssignment.id),
      businessNo: target.email,
      before: { roleCode: roleAssignment.roleCode, status: roleAssignment.status },
      after: { requestedStatus: "revoked", approvalId: Number(approval.id), reason },
      request,
    });
    return Response.json({
      success: true,
      roleAssignmentId: roleAssignment.id,
      approvalId: Number(approval.id),
      status: "pending",
    }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await requireAccess(request);
    requireRole(access, ["admin"]);
    if (access.localPreview) return Response.json({ success: true, preview: true });

    const body = await request.json() as { userId?: number; action?: "unlock" };
    if (!Number.isInteger(body.userId) || body.action !== "unlock") {
      return Response.json({ error: "仅支持指定账号的管理员解锁操作。" }, { status: 400 });
    }
    const db = getDb();
    const [target] = await db.select().from(users).where(eq(users.id, body.userId!)).limit(1);
    if (!target) return Response.json({ error: "账号不存在。" }, { status: 404 });
    if (target.accountStatus !== "locked") {
      return Response.json({ error: "该账号当前不是锁定状态。" }, { status: 409 });
    }

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(users)
        .set({ accountStatus: "active", updatedAt: now })
        .where(eq(users.id, target.id));
      await tx.update(authCredentials)
        .set({ failedAttempts: 0, lockedAt: null, updatedAt: now })
        .where(eq(authCredentials.userId, target.id));
      await tx.update(authSessions)
        .set({ revokedAt: now })
        .where(eq(authSessions.userId, target.id));
    });
    await writeAudit(access, {
      action: "unlock",
      module: "identity",
      entityType: "user",
      entityId: String(target.id),
      businessNo: target.email,
      before: { accountStatus: target.accountStatus },
      after: { accountStatus: "active", activeSessionsRevoked: true },
      request,
    });
    return Response.json({ success: true, userId: target.id, accountStatus: "active" });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
