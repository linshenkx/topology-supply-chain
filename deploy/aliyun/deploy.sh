#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"

if [[ ! -f ".env.production" ]]; then
  echo "缺少 deploy/aliyun/.env.production，请先从模板复制并安全填写。"
  exit 1
fi

export COMPOSE_ENV_FILES="${DEPLOY_DIR}/.env.production"
export RELEASE_TAG="${RELEASE_TAG:-${APP_IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}}"
export APP_IMAGE_TAG="${RELEASE_TAG}"
export API_IMAGE_TAG="${RELEASE_TAG}"
echo "准备发布镜像版本：${RELEASE_TAG}（Web/API 同版本）"

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

docker compose build app api migrator
docker compose --profile migration run --rm migrator node scripts/check-production-env.mjs
docker compose --profile migration run --rm migrator
docker compose up -d app api

if ! wait_for_service_health "Web" "app" "http://127.0.0.1:3000/api/health"; then
  exit 1
fi

if ! wait_for_service_health "API" "api" "http://127.0.0.1:3001/api/v1/health/ready"; then
  exit 1
fi

docker image prune -f --filter "until=168h" >/dev/null
echo "Web 与 API 均已发布到版本 ${RELEASE_TAG}。"
