#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"

if [[ ! -f ".env.production" ]]; then
  echo "缺少 deploy/aliyun/.env.production，请先从模板复制并安全填写。"
  exit 1
fi

export APP_IMAGE_TAG="${APP_IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
echo "准备发布镜像版本：${APP_IMAGE_TAG}"

docker compose build app migrator
docker compose --profile migration run --rm migrator node scripts/check-production-env.mjs
docker compose --profile migration run --rm migrator
docker compose up -d app

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
    echo "应用健康检查通过。"
    docker image prune -f --filter "until=168h" >/dev/null
    exit 0
  fi
  sleep 2
done

echo "应用健康检查失败，请执行 docker compose logs --tail=200 app 查看原因。"
exit 1
