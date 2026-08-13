import { r3Mutation, r3Read } from "../../../lib/r3-v1-bridge";
export const GET = r3Read("/api/v1/stocktakes");
export const POST = r3Mutation("/api/v1/stocktakes");
export const PATCH = r3Mutation("/api/v1/stocktakes");
