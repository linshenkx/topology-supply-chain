import { retiredPlatformRoute } from "../../../../lib/retired-writer";

export async function POST() {
  return retiredPlatformRoute("/api/v1/auth/step-up/request");
}
