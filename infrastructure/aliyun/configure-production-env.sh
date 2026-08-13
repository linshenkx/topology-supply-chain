#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

RDS_HOST=""
while [[ ! "${RDS_HOST}" =~ ^rm-[A-Za-z0-9-]+\.mysql(\.[a-z0-9-]+)?\.rds\.aliyuncs\.com$ ]]; do
  IFS= read -r -p "请输入RDS内网地址：" RDS_HOST </dev/tty
  if [[ ! "${RDS_HOST}" =~ ^rm-[A-Za-z0-9-]+\.mysql(\.[a-z0-9-]+)?\.rds\.aliyuncs\.com$ ]]; then
    echo "地址格式不正确，请只粘贴RDS内网主机地址。"
  fi
done

RDS_PASSWORD=""
while [[ -z "${RDS_PASSWORD}" ]]; do
  IFS= read -r -s -p "请输入已重置的新数据库密码：" RDS_PASSWORD </dev/tty
  echo
  if [[ -z "${RDS_PASSWORD}" ]]; then
    echo "密码不能为空，请重新输入。"
  fi
done

ENCODED_DB_PASSWORD="$(
  DB_PASSWORD="${RDS_PASSWORD}" python3 -c \
    'import os, urllib.parse; print(urllib.parse.quote(os.environ["DB_PASSWORD"], safe=""))'
)"
SESSION_SECRET="$(openssl rand -hex 32)"
API_SESSION_SIGNING_KEY="$(openssl rand -hex 32)"
OTP_SEALING_KEY="$(openssl rand -hex 32)"
JOB_TOKEN="$(openssl rand -hex 32)"
TEMP_FILE="$(mktemp ".env.production.tmp.XXXXXX")"
trap 'rm -f "${TEMP_FILE}"; unset RDS_PASSWORD ENCODED_DB_PASSWORD SESSION_SECRET API_SESSION_SIGNING_KEY OTP_SEALING_KEY JOB_TOKEN RDS_HOST' EXIT
umask 077

cat > "${TEMP_FILE}" <<EOF
APP_BASE_URL=https://scm.topologygz.com
APP_ENV=production
DEPLOY_TARGET=aliyun

SESSION_SECRET=${SESSION_SECRET}
API_SESSION_SIGNING_KEY=${API_SESSION_SIGNING_KEY}
OTP_SEALING_KEY_ID=v1
OTP_SEALING_KEY=${OTP_SEALING_KEY}
OTP_SEALING_KEYS_JSON={"v1":"${OTP_SEALING_KEY}"}
JOB_TOKEN=${JOB_TOKEN}

DATABASE_URL=mysql://Topology_scm_app:${ENCODED_DB_PASSWORD}@${RDS_HOST}:3306/topology_scm
DB_POOL_SIZE=10
DB_SSL=disabled
DB_SSL_REJECT_UNAUTHORIZED=true

OSS_REGION=oss-cn-guangzhou
OSS_BUCKET=topologygz-scm-prod
OSS_ECS_RAM_ROLE=TopologyScmEcsOssRole
OSS_INTERNAL_ENDPOINT=true

SMS_WEBHOOK_URL=
SMS_WEBHOOK_API_KEY=
SMS_WEBHOOK_HEALTH_URL=
SMS_ECS_RAM_ROLE=TopologyScmEcsOssRole
SMS_REGION_ID=cn-hangzhou
ALIYUN_SMS_SIGN_NAME=
ALIYUN_SMS_TEMPLATE_CODE=
EMAIL_WEBHOOK_URL=
EMAIL_WEBHOOK_API_KEY=
EMAIL_WEBHOOK_HEALTH_URL=
FILE_SCAN_WEBHOOK_URL=
FILE_SCAN_WEBHOOK_API_KEY=
FILE_SCAN_WEBHOOK_HEALTH_URL=

OPENAI_API_KEY=
EOF

chmod 600 "${TEMP_FILE}"
mv -f "${TEMP_FILE}" .env.production
trap - EXIT
unset RDS_PASSWORD ENCODED_DB_PASSWORD SESSION_SECRET API_SESSION_SIGNING_KEY OTP_SEALING_KEY JOB_TOKEN RDS_HOST

echo "生产配置已生成：${SCRIPT_DIR}/.env.production"
ls -l .env.production
sed -E \
  's#(mysql://[^:]+:)[^@]+@#\1***@#; s#^(SESSION_SECRET|API_SESSION_SIGNING_KEY|OTP_SEALING_KEY|OTP_SEALING_KEYS_JSON|JOB_TOKEN)=.*#\1=***#' \
  .env.production
