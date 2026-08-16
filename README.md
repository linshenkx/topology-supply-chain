# 拓扑供应链进销存管理系统

广州拓扑睡眠科技有限公司的供应链协同系统。本仓库是一个多运行时 monorepo：Web、Fastify API 与后台 Worker 分别构建和运行，但共享 Git、pnpm lockfile、契约、MySQL migration history 与发布清单。

本文是当前工程入口。文档按当前规范/能力、阶段验收、实施记录、逐提交审查和历史快照分类，统一从 [docs 文档索引](./docs/README.md) 路由。Scope A 最近一次已接受验收是 [Stage 11 真人与 Agent 联合 E2E 最终验收](./docs/refactor/stage11-t3-final-e2e-acceptance.md)（受控本机技术验收 GO）；2026-08-04 的生产与业务状态保留在 [PROJECT_STATUS 历史快照](./docs/history/PROJECT_STATUS.md)，不代表当前实时生产状态。

## 运行拓扑与支持矩阵

| 运行单元 | 源码/端口 | 生产责任 |
| --- | --- | --- |
| Web | `apps/web/app/`，内部 loopback 端口 | 页面与兼容入口；不拥有 `/api/v1` |
| API | `apps/api`，`:3001` | `/api/v1/*`、鉴权/权限、同步读写事务 |
| Worker | `apps/worker`，`:3002` | outbox/job、provider 副作用、独立 ready/fence |
| Contracts | `packages/contracts` | API Schema、DTO 与持久化 command/resource identity 事实源 |

| 平台 | 支持等级 | 边界 |
| --- | --- | --- |
| 阿里云 ECS + RDS MySQL + OSS | 生产主运行链 | Nginx → Web/API，Worker 独立运行；Compose/manifest 协同发布 |
| D1 + Vinext + Sites + Cloudflare adapter | 开发预览与兼容 | 仅保留本地预览、构建与 Gateway 接入；不得作为生产 MySQL/OSS 语义的替代 |

Web 已由 `apps/web` 独立 package 拥有；根 package 只负责编排 Web、API、Worker、contracts、database tooling 与仓库门禁。

## 工程边界

- MySQL migration history、release manifest、writer fence、command/resource、outbox、approval、file 与 audit identity 都是冻结协议。
- `topology_session`、`topology_csrf`、RBAC/data scope、CSRF/Origin、Step-up、事务/CAS/幂等和 unknown-outcome 语义不得被工程规整弱化。
- 18 个 legacy 业务 GET 保持精确 `410 + WRITER_MOVED + successor Link`；浏览器业务流统一经本地/测试 Gateway，生产继续经现有 Nginx。
- Purchase Receipt、BOM 实际库存预留/领料/消耗、质检放行/隔离等属于 Scope B，不在工程规范化范围内。

## 环境与安装

需要 Node.js `>=22.13.0`、pnpm `11.9.0`；真实 MySQL 门禁需要 MySQL 8。

```bash
pnpm install --frozen-lockfile
```

本地配置从 `.env.example` 开始，生产配置责任见 `infrastructure/aliyun/.env.production.template`。真实密码、AccessKey、令牌、生产数据和 `.env.local` 不得提交。

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

# 受控本机 Scope A E2E（loopback MySQL/API/Worker/Web HTTPS/stub）
pnpm test:e2e-foundation
pnpm test:e2e-scope-a
```

E2E 生命周期、随机端口、fixture、证据和真人检查点见 [Scope A 真人与 Agent E2E 手册](./docs/e2e/README.md)。这两项 E2E 是独立显式门禁，不属于普通 `test:mysql` 文件选择范围。

`pnpm lint` 运行完整 ESLint 检查；Stage 9 验收记录为 0 errors / 0 warnings。`pnpm lint:baseline` 是无新增债务回归门禁，后续专门批次可以减少问题，但不得新增文件/规则计数。

MySQL 门禁使用以下环境变量：

- `MYSQL_ADMIN_TEST_URL`：可创建/删除本门禁精确命名临时库的 MySQL 8 管理连接；
- `TEST_DATABASE_URL`：支付锁测试库；
- `MYSQL_WRITE_TEST_URL`、`MYSQL_SUPPLY_TEST_URL`、`MYSQL_OPERATIONS_TEST_URL`：已应用 canonical migration 的测试库。

## 部署入口

阿里云生产路径的事实源位于 [infrastructure/aliyun/README.md](./infrastructure/aliyun/README.md)：

- `infrastructure/aliyun/docker-compose.yml`：Web/API/Worker 与一次性 migrator；
- `infrastructure/aliyun/nginx-scm.conf`：公网只暴露 Nginx，`/api/v1/*` 归 API；
- `tooling/e2e/gateway.mjs`：本地/测试唯一 loopback Gateway，`/api/v1`（含子路径）归 API，其余路径归 Web；HTTP/HTTPS 共用同一分流逻辑。
- `infrastructure/aliyun/deploy.sh` / `rollback.sh`：manifest、migration 与 generation 兼容门禁；
- `tooling/release/activate-writers.sh`：独立、显式 writer activation；普通 deploy 不隐式激活 writer。

本地 workflow 已编码 frozen install、工程门禁与真实 MySQL suite。未 push 前只能说明 workflow 和本地验证就绪，不能声称 GitHub Actions 已绿色。

## 目录所有权

```text
apps/web/               独立 Web package、页面与兼容边界；不拥有 /api/v1
apps/api/               canonical Fastify API
apps/worker/            canonical 后台 Worker
apps/web/platform/      D1/Vinext/Sites 开发预览与兼容 adapter
packages/contracts/     跨边界协议与稳定 identity
database/               运行时 schema、MySQL/D1 migration 与数据库工具
infrastructure/aliyun/  阿里云 Compose、Nginx、部署与回滚
tooling/                build、checks、release 与 archive 工具入口
tests/                  Web/legacy/跨运行时/部署合同测试
archive/                历史与用途未完全确认资产；不参与 runtime/build/deploy
```

贡献和提交前门禁见 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全要求见 [SECURITY.md](./SECURITY.md)。
