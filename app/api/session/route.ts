import { accessErrorResponse, requireAccess } from "../../lib/authz";

export async function GET(request: Request) {
  try {
    const context = await requireAccess(request);
    return Response.json({
      user: {
        id: context.userId,
        email: context.email,
        name: context.name,
        roles: context.roles,
        factoryId: context.factoryId,
        supplierId: context.supplierId,
      },
      security: {
        passwordAttemptsBeforeLock: 5,
        trustedDeviceDays: 90,
        highRiskRequiresSms: true,
        separationOfDuties: true,
      },
      localPreview: context.localPreview,
    });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
