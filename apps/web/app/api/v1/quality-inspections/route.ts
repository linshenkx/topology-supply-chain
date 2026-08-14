import { operationsMutation, operationsRead } from "../../../lib/operations-v1-bridge";
export const GET = operationsRead("/api/v1/quality-inspections");
export const POST = operationsMutation("/api/v1/quality-inspections");
