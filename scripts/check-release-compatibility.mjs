import { pathToFileURL } from "node:url";

import { parseReleaseManifest } from "./release-manifest.mjs";

function stable(value) {
  return JSON.stringify(value);
}

function requireEqual(current, target, path) {
  if (stable(current) !== stable(target)) throw new Error(`Rollback manifest ${path} is incompatible; forward-fix is required.`);
}

export function checkReleaseCompatibility(current, target) {
  if (target.manifestVersion < current.compatibility.minimumManifestVersion) {
    throw new Error("Rollback target manifest version is below the active release minimum.");
  }
  if (target.compatibility.releaseSequence < current.compatibility.minimumReleaseSequence) {
    throw new Error("Rollback target release is below the active release minimum compatible version.");
  }
  requireEqual(current.contract, target.contract, "contract");
  requireEqual(current.schema, target.schema, "schema contract");
  requireEqual(current.writer.generation, target.writer.generation, "writer generation");
  requireEqual(current.writer.commands, target.writer.commands, "canonical command identities");
  requireEqual(current.writer.resources, target.writer.resources, "canonical resource identities");
  requireEqual(current.runtimeServices, target.runtimeServices, "runtime services");
  if (target.writer.legacyWriterCompatible !== false) {
    throw new Error("Rollback target permits a legacy writer; forward-fix is required.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const current = parseReleaseManifest(process.env.CURRENT_RELEASE_MANIFEST_JSON ?? "", "active release manifest");
  const target = parseReleaseManifest(process.env.TARGET_RELEASE_MANIFEST_JSON ?? "", "rollback target manifest");
  checkReleaseCompatibility(current, target);
  console.log("Rollback release manifests are schema, writer-generation, command, resource, and runtime compatible.");
}
