#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：./rollback.sh <web-image> <backend-image>"
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"
export WEB_IMAGE="$1"
export BACKEND_IMAGE="$2"
HTTP_PORT="$(sed -n 's/^HTTP_PORT=//p' .env.production | tail -n 1)"
: "${HTTP_PORT:=18080}"

docker pull "${WEB_IMAGE}"
docker pull "${BACKEND_IMAGE}"
docker compose --env-file .env.production up -d --no-build stub backend app nginx

for attempt in {1..40}; do
  if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null \
    && curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HTTP_PORT}/api/v1/health/ready" >/dev/null; then
    printf '%s\n%s\n' "${WEB_IMAGE}" "${BACKEND_IMAGE}" > .active-release
    echo "UAT 已回到指定镜像。数据库迁移未回滚。"
    exit 0
  fi
  sleep 3
done

docker compose --env-file .env.production logs --tail=120 backend app nginx
exit 1
