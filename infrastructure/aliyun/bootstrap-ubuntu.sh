#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 sudo 执行本脚本。"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg nginx unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

install -d -m 0750 /opt/topology-scm
install -d -m 0750 /opt/topology-scm/releases
install -d -m 0700 /etc/nginx/ssl/scm.topologygz.com
systemctl enable --now docker
systemctl enable nginx

echo "ECS基础环境已完成。下一步上传代码和HTTPS证书，暂不要开放应用账号。"
