#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：./rollback.sh <历史镜像版本号>"
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"
if [[ ! -f ".env.production" ]]; then
  echo "缺少 infrastructure/aliyun/.env.production，无法为回滚后的 API 注入数据库配置。"
  exit 1
fi

export COMPOSE_ENV_FILES="${DEPLOY_DIR}/.env.production"
export RELEASE_TAG="$1"
export APP_IMAGE_TAG="${RELEASE_TAG}"
export API_IMAGE_TAG="${RELEASE_TAG}"
export WORKER_IMAGE_TAG="${RELEASE_TAG}"

CURRENT_MANIFEST="$(mktemp "${DEPLOY_DIR}/.rollback-current-manifest.XXXXXX")"
TARGET_MANIFEST="$(mktemp "${DEPLOY_DIR}/.rollback-target-manifest.XXXXXX")"
cleanup() {
  rm -f "${CURRENT_MANIFEST}" "${TARGET_MANIFEST}"
}
trap cleanup EXIT

wait_for_service_health() {
  local display_name="$1"
  local service_name="$2"
  local health_url="$3"

  for attempt in {1..30}; do
    if curl -fsS --connect-timeout 2 --max-time 5 "${health_url}" >/dev/null; then
      echo "${display_name} 健康检查通过。"
      return 0
    fi
    sleep 2
  done

  echo "${display_name} 健康检查失败，请执行 docker compose logs --tail=200 ${service_name} 查看原因。"
  return 1
}

if ! docker image inspect "topology-scm:${APP_IMAGE_TAG}" >/dev/null 2>&1; then
  echo "服务器上不存在镜像 topology-scm:${APP_IMAGE_TAG}，停止回滚。"
  exit 1
fi

if ! docker image inspect "topology-scm-api:${API_IMAGE_TAG}" >/dev/null 2>&1; then
  echo "服务器上不存在镜像 topology-scm-api:${API_IMAGE_TAG}，停止回滚。"
  exit 1
fi

if ! docker image inspect "topology-scm-worker:${WORKER_IMAGE_TAG}" >/dev/null 2>&1; then
  echo "目标版本缺少同版本Worker镜像，停止回滚。"
  exit 1
fi
if ! docker image inspect "topology-scm-migrator:${RELEASE_TAG}" >/dev/null 2>&1; then
  echo "目标版本缺少同版本migrator镜像/manifest，停止回滚。"
  exit 1
fi

ACTIVE_RELEASE_TAG="$(cat .active-release 2>/dev/null || true)"
if [[ -z "${ACTIVE_RELEASE_TAG}" || ! -s .active-release-manifest.json ]]; then
  echo "缺少当前活动版本或manifest记录，停止回滚。"
  exit 1
fi
if ! docker image inspect "topology-scm-migrator:${ACTIVE_RELEASE_TAG}" >/dev/null 2>&1; then
  echo "当前活动migrator镜像不存在，无法执行可信回滚门禁。"
  exit 1
fi

docker run --rm "topology-scm-migrator:${ACTIVE_RELEASE_TAG}" node tooling/release/release-manifest.mjs print > "${CURRENT_MANIFEST}"
if ! cmp -s "${CURRENT_MANIFEST}" .active-release-manifest.json; then
  echo "活动镜像manifest与发布记录不一致，停止回滚。"
  exit 1
fi
docker run --rm "topology-scm-migrator:${RELEASE_TAG}" node tooling/release/release-manifest.mjs print > "${TARGET_MANIFEST}"
export CURRENT_RELEASE_MANIFEST_JSON="$(cat "${CURRENT_MANIFEST}")"
export TARGET_RELEASE_MANIFEST_JSON="$(cat "${TARGET_MANIFEST}")"

APP_IMAGE_TAG="${ACTIVE_RELEASE_TAG}" docker compose --profile migration run --rm \
  -e CURRENT_RELEASE_MANIFEST_JSON -e TARGET_RELEASE_MANIFEST_JSON \
  migrator node tooling/release/check-release-compatibility.mjs
APP_IMAGE_TAG="${ACTIVE_RELEASE_TAG}" docker compose --profile migration run --rm \
  -e TARGET_RELEASE_MANIFEST_JSON \
  migrator node tooling/release/check-legacy-rollback-safety.mjs

ROLLBACK_SERVICES=(app api worker)

docker compose up -d --no-build "${ROLLBACK_SERVICES[@]}"

if ! wait_for_service_health "Web" "app" "http://127.0.0.1:3000/api/health"; then
  exit 1
fi

if ! wait_for_service_health "API" "api" "http://127.0.0.1:3001/api/v1/health/ready"; then
  exit 1
fi

if ! wait_for_service_health "Worker" "worker" "http://127.0.0.1:3002/health/ready"; then
  exit 1
fi

printf '%s\n' "${RELEASE_TAG}" > .active-release
mv "${TARGET_MANIFEST}" .active-release-manifest.json
echo "Web、API 与 Worker 已协同回滚到版本 ${RELEASE_TAG}，健康检查通过。"
