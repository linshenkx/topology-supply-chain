# UAT 环境变量责任

当前阿里云目录用于并行测试环境，不是最终生产配置。变量事实源是 `tooling/checks/environment-contract.mjs`，执行 `pnpm deploy:check-env-contract` 会解析模板和标准化 Compose，确认 Web、Backend、迁移与 fixture 工具只收到各自所需变量。

## 必需变量

- `WEB_IMAGE`、`BACKEND_IMAGE`：带完整 Git SHA 的 ACR 镜像；
- `DATABASE_URL`：优先连接独立 `topology_scm_v2` 库；
- `API_SESSION_SIGNING_KEY`：至少 32 字符；
- `OTP_SEALING_KEY`：64 位十六进制；
- `LOCAL_FIXTURE_PASSWORD`：至少 12 字符；
- `PROJECT_ROOT=/opt/topology-scm-v2`、`HTTP_PORT=18080`。

## 测试环境固定值

Backend 以显式 `APP_ENV=local`、`DEPLOY_TARGET=local`、`NODE_ENV=test` 运行，允许 HTTP Cookie并使用固定验证码 `123456`。Provider URL/key 指向 Compose 内部 stub；文件写入 `/opt/topology-scm-v2/data/files`。这些值不得直接用于正式生产。

`.env.production` 虽沿用历史文件名，但只代表服务器私有部署参数。它不得包含 `SSH_PASSWORD`，不得提交 Git，也不得整文件注入 Web 或 Nginx。

完整操作见 [UAT 部署与运维手册](../../docs/deployment/topology-scm-v2-uat-runbook.md)。
