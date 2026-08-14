import { operationsMutation, operationsRead } from "../../../lib/operations-v1-bridge";
export const GET = operationsRead("/api/v1/stocktakes");
export const POST = operationsMutation("/api/v1/stocktakes");
export const PATCH = operationsMutation("/api/v1/stocktakes");
