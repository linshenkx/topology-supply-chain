# 拓扑供应链进销存管理系统

广州拓扑睡眠科技有限公司的供应链协同系统。本仓库是一个多运行时 monorepo：Web、Fastify API 与后台 Worker 分别构建和运行，但共享 Git、pnpm lockfile、契约、MySQL migration history 与发布清单。

本文是当前工程入口。2026-08-04 的生产与业务状态保留在 [PROJECT_STATUS.md](./PROJECT_STATUS.md)，该文件是历史快照，不代表当前实时生产状态。Scope A 的最近一次已记录验收见 [Stage 6 验收](./docs/refactor/stage6-scope-a-acceptance.md)。

## 运行拓扑与支持矩阵

| 运行单元 | 源码/端口 | 生产责任 |
| --- | --- | --- |
| Web | 根 `app/`，`:3000` | 页面、同域 bridge、`/api/health` 与兼容入口 |
| API | `apps/api`，`:3001` | `/api/v1/*`、鉴权/权限、同步读写事务 |
| Worker | `apps/worker`，`:3002` | outbox/job、provider 副作用、独立 ready/fence |
| Contracts | `packages/contracts` | API Schema、DTO 与持久化 command/resource identity 事实源 |

| 平台 | 支持等级 | 边界 |
| --- | --- | --- |
| 阿里云 ECS + RDS MySQL + OSS | 生产主运行链 | Nginx → Web/API，Worker 独立运行；Compose/manifest 协同发布 |
| D1 + Vinext + Sites + Cloudflare adapter | 开发预览与兼容 | 保留本地预览、构建与 bridge；不得作为生产 MySQL/OSS 语义的替代 |

根 `app/` 暂不搬到 `apps/web/`。目录非对称不改变三个运行时已经分离的事实；Web package 搬迁是后置、可选且需要独立兼容证明的机械任务。

## 工程边界

- MySQL migration history、release manifest、writer fence、command/resource、outbox、approval、file 与 audit identity 都是冻结协议。
- `topology_session`、`topology_csrf`、RBAC/data scope、CSRF/Origin、Step-up、事务/CAS/幂等和 unknown-outcome 语义不得被工程规整弱化。
- 18 个 legacy 业务 GET 保持精确 `410 + WRITER_MOVED + successor Link`；`/api/health`、`/api/session` 和 `/api/v1` 开发 bridge 保留。
- Purchase Receipt、BOM 实际库存预留/领料/消耗、质检放行/隔离等属于 Scope B，不在工程规范化范围内。

## 环境与安装

需要 Node.js `>=22.13.0`、pnpm `11.9.0`；真实 MySQL 门禁需要 MySQL 8。

```bash
pnpm install --frozen-lockfile
```

本地配置从 `.env.example` 开始，生产配置责任见 `deploy/aliyun/.env.production.template`。真实密码、AccessKey、令牌、生产数据和 `.env.local` 不得提交。

## 常用命令

```bash
# 开发预览（Vinext/D1/Sites 兼容链）
pnpm dev
pnpm build:web:preview

# 生产 Web 与独立运行时
pnpm build:web:production
pnpm build:api
pnpm build:worker

# 四套 TypeScript、真实 lint 债务回归、非 MySQL 测试、双 Web build
pnpm verify:local

# 需要五个显式测试 URL；缺失或发生 skip 均失败
pnpm verify:mysql

# 完整本地合同门禁
pnpm verify
```

`pnpm lint` 如实报告当前源码债务并可能非零退出；`pnpm lint:baseline` 是 T1 的无新增债务门禁，允许后续专门批次减少问题，但不允许新增文件/规则计数。

MySQL 门禁使用以下环境变量：

- `MYSQL_ADMIN_TEST_URL`：可创建/删除本门禁精确命名临时库的 MySQL 8 管理连接；
- `TEST_DATABASE_URL`：支付锁测试库；
- `MYSQL_WRITE_TEST_URL`、`MYSQL_R2_TEST_URL`、`MYSQL_R3_TEST_URL`：已应用 canonical migration 的测试库。

## 部署入口

阿里云生产路径的事实源位于 [deploy/aliyun/README.md](./deploy/aliyun/README.md)：

- `deploy/aliyun/docker-compose.yml`：Web/API/Worker 与一次性 migrator；
- `deploy/aliyun/nginx-scm.conf`：公网只暴露 Nginx，`/api/v1/*` 归 API；
- `deploy/aliyun/deploy.sh` / `rollback.sh`：manifest、migration 与 generation 兼容门禁；
- `scripts/activate-writers.sh`：独立、显式 writer activation；普通 deploy 不隐式激活 writer。

本地 workflow 已编码 frozen install、工程门禁与真实 MySQL suite。未 push 前只能说明 workflow 和本地验证就绪，不能声称 GitHub Actions 已绿色。

## 目录所有权

```text
app/                    根 Web package、bridge 与兼容边界
apps/api/               canonical Fastify API
apps/worker/            canonical 后台 Worker
packages/contracts/     跨边界协议与稳定 identity
db/ + drizzle*/         D1 source / MySQL generated schema 与双 migration lineage
deploy/aliyun/          阿里云 Compose、Nginx、部署与回滚
scripts/                migration、release、fence 与仓库验证入口
tests/                  Web/legacy/跨运行时/部署合同测试
archive/                历史与用途未完全确认资产；不参与 runtime/build/deploy
```

贡献和提交前门禁见 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全要求见 [SECURITY.md](./SECURITY.md)。
