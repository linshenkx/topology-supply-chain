import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() { return retiredPlatformRoute("/api/v1/inventory"); }
export async function POST() { return retiredPlatformRoute("/api/v1/inventory"); }
