#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"

if [[ ! -f .env.production ]]; then
  echo "缺少 ${DEPLOY_DIR}/.env.production"
  exit 1
fi

read_env() {
  local name="$1"
  sed -n "s/^${name}=//p" .env.production | tail -n 1
}

PROJECT_ROOT="$(read_env PROJECT_ROOT)"
HTTP_PORT="$(read_env HTTP_PORT)"
WEB_IMAGE="$(read_env WEB_IMAGE)"
BACKEND_IMAGE="$(read_env BACKEND_IMAGE)"
: "${PROJECT_ROOT:=/opt/topology-scm-v2}"
: "${HTTP_PORT:=18080}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"

mkdir -p "${PROJECT_ROOT}/data/files" "${PROJECT_ROOT}/backups" "${PROJECT_ROOT}/source"
chmod 700 "${PROJECT_ROOT}" "${PROJECT_ROOT}/data" "${PROJECT_ROOT}/data/files" "${PROJECT_ROOT}/backups"

docker compose --env-file .env.production config --quiet
docker pull "${WEB_IMAGE}"
docker pull "${BACKEND_IMAGE}"
docker compose --env-file .env.production --profile tools run --rm migrator
docker compose --env-file .env.production --profile tools run --rm bootstrap
docker compose --env-file .env.production up -d --remove-orphans stub backend app nginx

for attempt in {1..40}; do
  if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null \
    && curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HTTP_PORT}/api/v1/health/ready" >/dev/null; then
    printf '%s\n%s\n' "${WEB_IMAGE}" "${BACKEND_IMAGE}" > .active-release
    echo "topology-scm-v2 UAT 已就绪：http://127.0.0.1:${HTTP_PORT}"
    exit 0
  fi
  sleep 3
done

docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=120 backend app nginx
echo "UAT 健康检查失败。"
exit 1
