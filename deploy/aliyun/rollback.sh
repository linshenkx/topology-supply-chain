#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：./rollback.sh <历史镜像版本号>"
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"
export APP_IMAGE_TAG="$1"

if ! docker image inspect "topology-scm:${APP_IMAGE_TAG}" >/dev/null 2>&1; then
  echo "服务器上不存在镜像 topology-scm:${APP_IMAGE_TAG}，停止回滚。"
  exit 1
fi

docker compose up -d --no-build app
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
    echo "已回滚到版本 ${APP_IMAGE_TAG}，健康检查通过。"
    exit 0
  fi
  sleep 2
done

echo "回滚版本未通过健康检查，请查看应用日志。"
exit 1
