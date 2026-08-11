#!/usr/bin/env bash
set -euo pipefail

# Scope A retired the browser-callable /api/jobs/* endpoints. Scheduling and
# delivery now live inside the compose-managed Worker process.
systemctl disable --now topology-reminders.timer topology-email.timer 2>/dev/null || true
systemctl disable --now topology-reminders.service topology-email.service 2>/dev/null || true

rm -f \
  /etc/systemd/system/topology-reminders.timer \
  /etc/systemd/system/topology-reminders.service \
  /etc/systemd/system/topology-email.timer \
  /etc/systemd/system/topology-email.service
systemctl daemon-reload

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DEPLOY_DIR}"
docker compose up -d worker
curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  http://127.0.0.1:3002/health/ready >/dev/null
echo "旧 HTTP 定时器已退休；Topology Worker 正在运行。"
