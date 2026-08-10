#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 用户运行，或执行：sudo bash bootstrap-alinux3.sh"
  exit 1
fi

dnf -y update
dnf -y install wget curl nginx

wget -O /etc/yum.repos.d/docker-ce.repo \
  http://mirrors.cloud.aliyuncs.com/docker-ce/linux/centos/docker-ce.repo
sed -i \
  's|https://mirrors.aliyun.com|http://mirrors.cloud.aliyuncs.com|g' \
  /etc/yum.repos.d/docker-ce.repo

dnf -y install dnf-plugin-releasever-adapter --repo alinux3-plus
dnf -y install \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

systemctl enable --now docker
systemctl enable --now nginx

install -d -m 0750 /opt/topology-scm
install -d -m 0750 /opt/topology-scm/backups
install -d -m 0750 /var/log/topology-scm

echo "Alibaba Cloud Linux 3 基础环境安装完成。"
echo "Docker: $(docker --version)"
echo "Compose: $(docker compose version)"
echo "Nginx: $(nginx -v 2>&1)"
