#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/topology-scm"
cd "$APP_DIR/infrastructure/aliyun"
set -a
source .env.production
set +a

cd "$APP_DIR"
export NODE_OPTIONS="--max-old-space-size=1536"
pnpm build:aliyun

mkdir -p apps/web/.next/standalone/.next
/bin/cp -af apps/web/.next/static apps/web/.next/standalone/.next/
/bin/cp -af apps/web/public apps/web/.next/standalone/
chown -R topologyscm:topologyscm apps/web/.next/standalone

systemctl restart topology-scm
sleep 5
systemctl is-active --quiet topology-scm

HEALTH="$(curl --fail --max-time 30 -s http://127.0.0.1:3000/api/health)"
echo "$HEALTH"
if [[ "$HEALTH" != *'"status":"ok"'* ]]; then
  echo "健康检查未达到 ok，请检查服务日志。" >&2
  exit 1
fi
echo "BOM 版本功能部署完成。"
