# topology-scm-v2 阿里云 UAT 部署

本目录是当前测试环境部署入口。运行拓扑只有两个自定义镜像：

- Web：前端运行时；
- Backend：API 与后台 Outbox/提醒/文件扫描循环；同一镜像也用于一次性迁移、测试账号初始化和本地 provider stub。

Nginx 使用官方 `nginx:1.27-alpine` 的 ACR 镜像标签（仅解决 ECS 访问 Docker Hub 不稳定，不是第三个业务构建镜像），RDS 使用外部 MySQL，不在服务器创建 MySQL 容器。所有项目文件统一位于 `/opt/topology-scm-v2`，旧 `/opt/topology-scm` 演示服务不在本次切换范围内。

完整步骤、更新、备份、回滚和故障处理见 [UAT 部署与运维手册](../../docs/deployment/topology-scm-v2-uat-runbook.md)。

常用命令：

```bash
cd /opt/topology-scm-v2/compose
./deploy.sh
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=200 backend app nginx
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18080/api/v1/health/ready
```

UAT 通过 SSH 隧道访问：

```powershell
ssh -N -L 18080:127.0.0.1:18080 topology-supply-chain
```

然后浏览器打开 <http://127.0.0.1:18080>。测试账号由 `LOCAL_FIXTURE_RUN_ID` 决定，默认 `uat`；验证码固定为 `123456`。该配置仅用于测试验收，不是正式生产配置。
