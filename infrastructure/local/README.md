# 本地完整 Docker 启动

本目录提供与生产部署分离的本地自包含运行链：MySQL、迁移、测试数据、Web、Backend（API 与后台任务）、本地文件存储、本地 provider stub 与 Nginx。浏览器只访问 Nginx 的 HTTP 入口；本地不需要证书，也不使用 Web 内部 bridge 或 E2E gateway。

## 启动

```powershell
pnpm local:up
pnpm local:smoke
```

首次构建完成后访问 <http://127.0.0.1:8080>。默认测试账号包括：

- `admin.local@e2e.invalid`
- `supply_chain.local@e2e.invalid`
- `factory.local@e2e.invalid`

默认密码为 `LocalTest!2026`，登录及高风险操作的本地验证码统一为 `123456`。这些账号、密码、验证码、数据库口令和 provider key 都是仅绑定本机的测试值，不得复制到生产环境。

如需核对本地 Stub 当前收到的验证码，也可以执行：

```powershell
pnpm local:otp
```

查看状态和日志：

```powershell
pnpm local:status
pnpm local:logs
```

## 停止与数据

普通停止会保留 MySQL 和文件 named volume，便于下次继续验证：

```powershell
pnpm local:down
```

需要从空库重新开始时，显式删除本地 volume：

```powershell
pnpm local:reset
```

默认只向 `127.0.0.1` 暴露 Nginx `8080` 和 MySQL 调试端口 `3307`。Web、Backend 和 stub 只在 Compose 网络内可见。端口和 fixture 标识可以复制 `.env.example` 后覆盖。

## 与生产的边界

- 本地 API 以 `APP_ENV=local`、`DEPLOY_TARGET=local`、`NODE_ENV=test` 运行，并显式允许 HTTP Cookie；生产和阿里云配置仍强制 Secure Cookie。
- 文件上传写入仅供本地环境使用的 `file-data` named volume；`local:smoke` 会验证上传、扫描和下载，生产仍使用 OSS。
- 本地 Compose 的应用容器统一以 root 运行，权限边界由容器、只读根文件系统和独立 named volume 提供；生产镜像及阿里云 Compose 的运行用户策略不受影响。
- bootstrap 只为本地测试库创建合成 fixture，并按冻结 release manifest 的 owner/generation 精确启用 writer fence；它不是生产初始化方式。
- 本地 stub 只替代短信、邮件和文件扫描 provider。生产仍使用真实云服务配置。
- 生产部署继续使用 `infrastructure/aliyun/`，不得把本目录的测试值迁入生产。
