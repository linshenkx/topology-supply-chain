# topology-scm-v2 UAT 部署与运维手册

## 1. 适用范围

本手册用于当前阿里云测试环境，不是最终生产切换方案。目标是在不影响服务器旧演示服务的前提下，以最新 `main`、外部 RDS 和两份自定义镜像提供可重复更新的 UAT 环境。

测试环境固定约束：

- 服务器：`8.138.82.131`；
- 根目录：`/opt/topology-scm-v2`；
- 容器入口：仅监听服务器回环地址 `127.0.0.1:18080`；
- 公网访问：宿主机 Nginx 在 <https://scm.topologygz.com> 终止 TLS，再转发到回环入口；
- 验证码：`123456`；
- 数据：最新迁移与合成 UAT fixture 为准；旧演示库只备份，不做历史兼容扩展；
- 容器：统一以 root 运行，权限边界由容器网络、只读根文件系统和专用挂载目录提供。

## 2. 运行拓扑

| 服务 | 镜像 | 作用 |
| --- | --- | --- |
| `nginx` | 官方 `nginx:1.27-alpine` 的 ACR 镜像标签 | 容器内 HTTP 网关，路由 Web 与 `/api/v1/*` 并保留宿主机传入的 HTTPS 元数据 |
| `app` | `topology-scm-web-<git-sha>` | 前端 |
| `backend` | `topology-scm-backend-<git-sha>` | API 与后台任务循环 |
| `stub` | Backend 同镜像 | UAT 短信、邮件、文件扫描替身 |
| `migrator` | Backend 同镜像 | 一次性调用镜像内 Drizzle CLI 执行 `0000-0005` 迁移 |
| `bootstrap` | Backend 同镜像 | 一次性创建 UAT 账号/fixture 并启用冻结 writer fence |

Worker 不再单独部署；Migrator 不再维护独立镜像。`stub`、`migrator`、`bootstrap` 只是复用 Backend 镜像的不同命令。

## 3. 服务器目录

```text
/opt/topology-scm-v2/
├── compose/                 # Compose、Nginx 配置、部署脚本、私有 env
├── source/                  # 完整 Git/source 交付副本，只读挂载到容器
├── data/files/              # UAT 文件上传数据
├── backups/                 # 旧演示服务与 RDS 逻辑备份
└── evidence/                # 部署和回归结果
```

禁止把本项目文件散落到 `/etc`、`/srv` 或其他项目目录。旧 `/etc/topology-scm.env` 只作为旧系统备份来源，不作为 v2 配置。

## 4. 镜像构建与发布

在本地仓库根目录执行，标签必须带完整 Git SHA：

```powershell
$sha = git rev-parse HEAD
$registry = "registry.cn-guangzhou.aliyuncs.com/bigdata200/my-opc-workbench"

docker build -f infrastructure/docker/web.Dockerfile --target runner `
  -t "${registry}:topology-scm-web-${sha}" .
docker build -f infrastructure/docker/api.Dockerfile --target runner `
  -t "${registry}:topology-scm-backend-${sha}" .

docker push "${registry}:topology-scm-web-${sha}"
docker push "${registry}:topology-scm-backend-${sha}"
```

禁止使用 `latest`，禁止覆盖 OPC 现有标签。发布后记录 registry digest；Compose 可以继续使用 SHA 标签，验收证据必须同时记录 digest。

## 5. 首次部署

### 5.1 部署前备份

部署前必须先保存：

1. 旧 `/opt/topology-scm` 文件；
2. `/etc/topology-scm.env`；
3. `topology-scm.service` unit；
4. 旧 Nginx 配置；
5. RDS `topology_scm` 逻辑备份和 SHA-256。

备份只写入 `/opt/topology-scm-v2/backups/<timestamp>/`，权限 `0700`。本次不停止、不覆盖旧 systemd/Nginx 服务。

### 5.2 写入配置

```bash
install -d -m 700 /opt/topology-scm-v2/{compose,source,data/files,backups,evidence}
install -m 600 infrastructure/aliyun/.env.production.template \
  /opt/topology-scm-v2/compose/.env.production
```

必须填写 `WEB_IMAGE`、`BACKEND_IMAGE`、`DATABASE_URL`、`API_SESSION_SIGNING_KEY`、`OTP_SEALING_KEY` 和 `LOCAL_FIXTURE_PASSWORD`。脚本不会把该文件当 shell 脚本执行，只由 Compose 按 env-file 规则解析；`.env.production` 不得包含 SSH 密码，不得提交 Git。

### 5.3 数据库策略

优先使用独立新库 `topology_scm_v2`。如果应用账号没有建库权限：

- 保留旧库备份；
- 不直接删除旧表；
- 由数据库负责人创建新库或明确批准清理演示库后再继续。

迁移只允许 append-only `0000-0005`，禁止改写历史 SQL/hash。

### 5.4 启动

```bash
cd /opt/topology-scm-v2/compose
chmod 700 deploy.sh rollback.sh
./deploy.sh
```

脚本顺序为：校验 Compose → 拉取两镜像 → 一次性迁移 → 一次性 fixture 初始化 → 启动 stub/backend/app/nginx → 回环健康检查。

## 6. 访问与测试账号

直接访问 <https://scm.topologygz.com>。证书由宿主机 Certbot 管理，路径为 `/etc/letsencrypt/live/scm.topologygz.com/`，自动续期时保留 80 端口的 `/.well-known/acme-challenge/` 路由。

仅在排障时可建立回环隧道：

```powershell
ssh -N -L 18080:127.0.0.1:18080 topology-supply-chain
```

默认 `LOCAL_FIXTURE_RUN_ID=uat` 时账号包括：

- `admin.uat@e2e.invalid`
- `supply_chain.uat@e2e.invalid`
- `factory.uat@e2e.invalid`
- `company_qc.uat@e2e.invalid`

密码取服务器 `.env.production` 的 `LOCAL_FIXTURE_PASSWORD`，验证码固定 `123456`。账号只用于 UAT。

## 7. 日常检查

```bash
cd /opt/topology-scm-v2/compose
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=200 backend
docker compose --env-file .env.production logs --tail=200 app nginx
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18080/api/v1/health/ready
curl -fsS https://scm.topologygz.com/healthz
```

数据库、审计与 Outbox 只做最小只读核对；不要用直接删库/删表代替业务清理。

## 8. 更新

1. 本地完成代码验证并推送 `main`；
2. 以新 Git SHA 构建并推送两镜像；
3. 把完整源码同步到 `/opt/topology-scm-v2/source`；
4. 备份服务器当前 `.env.production`；
5. 只修改 `WEB_IMAGE`、`BACKEND_IMAGE`；
6. 再次执行 `./deploy.sh`；
7. 执行健康检查和核心业务冒烟。

脚本不执行 `docker image prune`，不会删除未知镜像或其他项目资源。

## 9. 回滚

数据库迁移不回滚；应用回滚只切换到已知兼容的历史 Web/Backend 镜像：

```bash
./rollback.sh \
  registry.cn-guangzhou.aliyuncs.com/bigdata200/my-opc-workbench:topology-scm-web-<old-sha> \
  registry.cn-guangzhou.aliyuncs.com/bigdata200/my-opc-workbench:topology-scm-backend-<old-sha>
```

若历史镜像不兼容当前 schema，停止回滚并采用 forward-fix。禁止回滚 migration 文件或修改 `__drizzle_migrations`。

## 10. 故障处理

- `backend` 不健康：查 RDS、provider stub、writer fence 和 Backend 日志；
- 登录失败：确认 fixture 初始化成功、密码来源正确、验证码为 `123456`；
- 文件上传失败：确认 `/opt/topology-scm-v2/data/files` 可写且 stub 健康；
- 页面正常但 API 404：检查 `nginx-uat.conf` 的 `/api/v1/` 路由；
- HTTP 页面报 `crypto.randomUUID is not a function`：必须使用公网 HTTPS 地址；公网 HTTP 只允许重定向，不能作为浏览器验收入口；
- 镜像拉取失败：确认服务器 ACR 登录状态和镜像标签，不要改用 `latest`；
- 端口冲突：仅调整 `.env.production` 的 `HTTP_PORT`，不要动旧服务的 80/3000。

## 11. 本阶段不包含

- 正式生产证书治理、WAF/CDN 与安全组收紧；
- 真实短信、邮件、OSS、AI provider；
- 旧 demo 数据迁移和兼容层；
- 完整生产监控、灾备演练或高可用；
- 最终客户镜像仓库创建与账号治理。
