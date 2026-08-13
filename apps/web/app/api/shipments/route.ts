import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() { return retiredPlatformRoute("/api/v1/shipments"); }
export async function POST() { return retiredPlatformRoute("/api/v1/shipments"); }
