# 操作日志审计中心增量部署

本增量增加管理员操作日志查询、组合筛选、分页及带导出人和导出时间水印的 Excel 导出。日志查看和导出行为也会写入审计日志。

```bash
cd /opt/topology-scm
sha256sum archive/legacy-deliveries/topology-scm-audit-center-20260802.tar.gz
tar -xzf archive/legacy-deliveries/topology-scm-audit-center-20260802.tar.gz
cd /opt/topology-scm/deploy/aliyun
set -a
source .env.production
set +a
cd /opt/topology-scm
export NODE_OPTIONS="--max-old-space-size=1536"
pnpm build:aliyun
mkdir -p .next/standalone/.next
/bin/cp -af .next/static .next/standalone/.next/
/bin/cp -af public .next/standalone/
chown -R topologyscm:topologyscm .next/standalone
systemctl restart topology-scm
sleep 5
systemctl is-active topology-scm
curl --max-time 30 -sS http://127.0.0.1:3000/api/health
```

部署后以管理员登录，在“系统管理”页面底部查看“操作日志审计中心”。本增量不需要执行数据库迁移。
