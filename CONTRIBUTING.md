# 协作开发指南

## 开发环境

- Node.js 22.13.0 或更高版本
- pnpm 11.9.0（由根 `packageManager` 固定）
- MySQL 8（仅真实数据库合同门禁需要）

```bash
pnpm install --frozen-lockfile
```

复制 `.env.example` 为本机配置并只填写非生产测试值。真实密码、AccessKey、令牌、手机号清单、附件、生产数据和 `.env.local` 不得进入 Git、压缩包、日志或聊天记录。

## 支持与范围

- 阿里云/MySQL/OSS 是生产主运行链。
- D1/Vinext/Sites/Cloudflare adapter 只保留开发预览与兼容能力；修改生产路径时仍要验证它们未被误删或破坏。
- `apps/web` 是独立 Web package；普通业务功能不得把 Web runtime 依赖或配置搬回根 package。
- 工程任务不得顺带实现 Purchase Receipt、BOM 实际库存预留/领料/消耗、质检放行/隔离等 Scope B。

## 提交前门禁

普通代码或配置变更至少运行：

```bash
pnpm verify:local
```

它串行执行四套 TypeScript、ESLint 无新增债务基线、Web/API/Worker 全部非 MySQL 测试、Vinext 预览构建和 Aliyun/Next 生产构建。`pnpm lint` 保留为真实问题清单；不要用全仓格式化或无关源码修改掩盖现有债务。

涉及 API、Worker、数据库、migration、事务、writer fence、Step-up、audit/outbox 或路径移动时，还必须准备 canonical MySQL 8 测试库并运行：

```bash
pnpm verify:mysql
```

必须显式设置 `MYSQL_ADMIN_TEST_URL`、`TEST_DATABASE_URL`、`MYSQL_WRITE_TEST_URL`、`MYSQL_SUPPLY_TEST_URL`、`MYSQL_OPERATIONS_TEST_URL`。任何缺失或 TAP skip 都视为失败；不要把“无数据库所以跳过”报告为绿色。

只需定向检查时可使用：

```bash
pnpm typecheck
pnpm test:root
pnpm test:api
pnpm test:worker
pnpm test:mysql
pnpm build:web:production
```

受控本机 Scope A E2E 使用独立显式入口，不由 `test:mysql` 隐式选择：

```bash
pnpm test:e2e-foundation
pnpm test:e2e-scope-a
```

它们会创建精确 RUN_ID 的 loopback MySQL/API/Worker/Web HTTPS/stub 资源并在结束时清理；执行者必须遵守 [E2E 手册](./docs/e2e/README.md)，不得连接生产或真实 provider。

## 安全与兼容审查

改动必须保持：

- `topology_session` / `topology_csrf` 的名称、属性与清除语义；
- session/RBAC/data scope、CSRF/Origin、Step-up 绑定；
- MySQL transaction/lock/CAS/idempotency/deadline/unknown-outcome；
- writer fence、事务内 audit/outbox、文件 quarantine/ACL；
- legacy 业务 GET 的精确 410 合同，以及 `/api/health`、`/api/session`、`/api/v1` bridge；
- migration frozen history、release manifest 和所有持久化 identity。

涉及价格、付款、BOM、供应商、权限或审批时，除正向行为外还要验证职责分离、负向 data scope 与审计证据。

## 数据库与发布

- migration 只允许 append-only；禁止改写历史 SQL、snapshot、journal 或 canonical hash。
- 生产发布、writer activation 和 rollback 是三个不同责任。普通 deploy 不得隐式改变 writer owner/enabled/generation。
- 禁止提交生产库导出或包含真实业务数据的 SQL。
- 未获明确授权不得 push、merge、tag、deploy 或使用生产凭据。

每个提交只包含一个可解释结果，并在说明中列出范围、验证、数据库/权限影响与回滚方式。
