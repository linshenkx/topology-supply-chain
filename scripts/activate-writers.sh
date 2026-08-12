#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "用法：scripts/activate-writers.sh <activation-evidence.json> <resource> [resource ...]"
  echo "资源 allowlist 默认为空；未显式给出证据和资源时不会改变 writer fence。"
  exit 1
fi

EVIDENCE_PATH="$(realpath "$1")"
if [[ ! -f "${EVIDENCE_PATH}" ]]; then
  echo "激活证据文件不存在，停止激活。"
  exit 1
fi
shift

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPOSITORY_ROOT}/deploy/aliyun"
cd "${DEPLOY_DIR}"
if [[ ! -f ".env.production" ]]; then
  echo "缺少 deploy/aliyun/.env.production，停止激活。"
  exit 1
fi
if [[ ! -s ".active-release" || ! -s ".active-release-manifest.json" ]]; then
  echo "缺少当前活动 release/manifest 记录，停止激活。"
  exit 1
fi

export COMPOSE_ENV_FILES="${DEPLOY_DIR}/.env.production"
export RELEASE_TAG="$(tr -d '\r\n' < .active-release)"
export APP_IMAGE_TAG="${RELEASE_TAG}"
export API_IMAGE_TAG="${RELEASE_TAG}"
export WORKER_IMAGE_TAG="${RELEASE_TAG}"
export WRITER_ACTIVATION_RESOURCES
WRITER_ACTIVATION_RESOURCES="$(IFS=,; printf '%s' "$*")"
export WRITER_ACTIVATION_EVIDENCE_SHA256
WRITER_ACTIVATION_EVIDENCE_SHA256="$(sha256sum "${EVIDENCE_PATH}" | awk '{print $1}')"

CURRENT_MANIFEST="$(mktemp "${DEPLOY_DIR}/.activation-manifest.XXXXXX")"
cleanup() {
  rm -f "${CURRENT_MANIFEST}"
}
trap cleanup EXIT

if ! docker image inspect "topology-scm-migrator:${RELEASE_TAG}" >/dev/null 2>&1; then
  echo "当前活动 migrator 镜像不存在，停止激活。"
  exit 1
fi
docker run --rm "topology-scm-migrator:${RELEASE_TAG}" node scripts/release-manifest.mjs print > "${CURRENT_MANIFEST}"
if ! cmp -s "${CURRENT_MANIFEST}" .active-release-manifest.json; then
  echo "活动镜像 manifest 与发布记录不一致，停止激活。"
  exit 1
fi

echo "准备激活 release=${RELEASE_TAG} resources=${WRITER_ACTIVATION_RESOURCES} evidence=${WRITER_ACTIVATION_EVIDENCE_SHA256}"
docker compose --profile migration run --rm \
  -e RELEASE_TAG \
  -e WRITER_ACTIVATION_RESOURCES \
  -e WRITER_ACTIVATION_EVIDENCE_SHA256 \
  -v "${EVIDENCE_PATH}:/tmp/writer-activation-evidence.json:ro" \
  migrator node scripts/set-writer-fences.mjs /tmp/writer-activation-evidence.json
echo "显式 writer 激活完成；请按证据中的 observability checks 持续观察该波次。"
