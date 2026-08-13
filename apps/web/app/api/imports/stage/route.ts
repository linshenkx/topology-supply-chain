import { retiredPlatformRoute } from "../../../lib/retired-writer";

export async function POST() {
  return retiredPlatformRoute("/api/v1/imports/stage");
}
