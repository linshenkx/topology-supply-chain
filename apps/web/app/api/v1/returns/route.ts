import { r3Mutation, r3Read } from "../../../lib/r3-v1-bridge";
export const GET = r3Read("/api/v1/returns");
export const POST = r3Mutation("/api/v1/returns");
