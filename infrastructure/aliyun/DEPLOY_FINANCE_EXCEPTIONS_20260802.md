# 财务异常闭环增量部署（2026-08-02）

此增量不包含数据库结构变更，无需执行迁移。

```bash
cd /opt/topology-scm
sha256sum archive/legacy-deliveries/topology-scm-finance-exceptions-20260802.tar.gz
tar -xzf archive/legacy-deliveries/topology-scm-finance-exceptions-20260802.tar.gz

cd /opt/topology-scm/infrastructure/aliyun
set -a
source .env.production
set +a

cd /opt/topology-scm
export NODE_OPTIONS="--max-old-space-size=1536"
pnpm build:aliyun

mkdir -p apps/web/.next/standalone/.next
/bin/cp -af apps/web/.next/static apps/web/.next/standalone/.next/
/bin/cp -af apps/web/public apps/web/.next/standalone/
chown -R topologyscm:topologyscm apps/web/.next/standalone

systemctl restart topology-scm
sleep 5
systemctl is-active topology-scm
curl --max-time 30 -sS http://127.0.0.1:3000/api/health
```

预期服务状态为 `active`，健康检查返回 `"status":"ok"`。
