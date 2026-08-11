import { retiredPlatformRoute } from "../../lib/retired-writer";

export async function GET() {
  return retiredPlatformRoute("/api/v1/users");
}

export async function POST() {
  return retiredPlatformRoute("/api/v1/users");
}

export async function DELETE() {
  return retiredPlatformRoute("/api/v1/users");
}

export async function PATCH() {
  return retiredPlatformRoute("/api/v1/users");
}
