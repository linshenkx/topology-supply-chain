import { retiredPlatformRoute } from "../../../lib/retired-writer";

export async function POST() {
  return retiredPlatformRoute("internal://topology-worker/outbox");
}
