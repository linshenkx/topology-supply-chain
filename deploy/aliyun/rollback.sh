#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：./rollback.sh <历史镜像版本号>"
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"
if [[ ! -f ".env.production" ]]; then
  echo "缺少 deploy/aliyun/.env.production，无法为回滚后的 API 注入数据库配置。"
  exit 1
fi

export COMPOSE_ENV_FILES="${DEPLOY_DIR}/.env.production"
export RELEASE_TAG="$1"
export APP_IMAGE_TAG="${RELEASE_TAG}"
export API_IMAGE_TAG="${RELEASE_TAG}"

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

docker compose up -d --no-build app api

if ! wait_for_service_health "Web" "app" "http://127.0.0.1:3000/api/health"; then
  exit 1
fi

if ! wait_for_service_health "API" "api" "http://127.0.0.1:3001/api/v1/health/ready"; then
  exit 1
fi

echo "Web 与 API 已协同回滚到版本 ${RELEASE_TAG}，健康检查通过。"
