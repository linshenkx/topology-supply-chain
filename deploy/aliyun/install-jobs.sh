#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env.production"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "缺少.env.production。"
  exit 1
fi

JOB_TOKEN="$(grep -E '^JOB_TOKEN=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"
if [[ -z "${JOB_TOKEN}" ]]; then
  echo "JOB_TOKEN未配置。"
  exit 1
fi

install -d -m 0750 /etc/topology-scm
umask 077
printf 'JOB_TOKEN=%q\n' "${JOB_TOKEN}" > /etc/topology-scm/jobs.env

cat > /etc/systemd/system/topology-reminders.service <<'EOF'
[Unit]
Description=Topology SCM reminder scheduler
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/topology-scm/jobs.env
ExecStart=/usr/bin/curl --fail --silent --show-error --request POST --header "x-topology-job-token: ${JOB_TOKEN}" http://127.0.0.1:3000/api/jobs/reminders
EOF

cat > /etc/systemd/system/topology-reminders.timer <<'EOF'
[Unit]
Description=Run Topology SCM reminders every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/topology-email.service <<'EOF'
[Unit]
Description=Topology SCM email queue worker
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/topology-scm/jobs.env
ExecStart=/usr/bin/curl --fail --silent --show-error --request POST --header "x-topology-job-token: ${JOB_TOKEN}" http://127.0.0.1:3000/api/jobs/email
EOF

cat > /etc/systemd/system/topology-email.timer <<'EOF'
[Unit]
Description=Run Topology SCM email worker every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now topology-reminders.timer topology-email.timer
echo "提醒与邮件定时任务已启用。"
