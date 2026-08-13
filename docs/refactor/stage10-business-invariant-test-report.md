# Stage 10 基础业务测试补充报告

> 基线：`d9c5fea881e304c97713ae777675cd059e8dade4`
> 范围：仅测试、测试证据与本报告；未修改生产源码、契约、依赖、迁移或部署配置。

## 本次增量证据

- `apps/api/test/command-executor-parity.test.mjs`：共享平台/R2/R3 执行器状态机仍只验证一次；表驱动验证 12 条 R2 与 13 条 R3 命令均返回自己的命令 identity，并使用冻结的 writer resource。
- `apps/api/test/r2-master-procurement.test.mjs`：12 条 R2 路由逐条验证缺失 Origin 与 CSRF 在 domain handler / UnitOfWork 前拒绝。
- `apps/api/test/r3-write-migration.test.mjs`：13 条 R3 route-method 逐条以空 body 验证 Fastify schema 边界拒绝；合法最小 body 的已有合同测试仍保留。

这不是“25 个 handler 的真实 MySQL 全覆盖”声明。现有真实 MySQL suite 证明代表性 R2/R3 的原子、审计、Outbox、replay、fence、支付锁与审批/库存不变量；各 handler 的字段关系与状态效果仍是矩阵列出的 Critical 缺口。

## 验证

- 基线与最终 `pnpm lint`、`pnpm typecheck`：通过。
- 基线 `pnpm test:non-mysql`：54 files，359 pass，0 fail，0 skip；最终完整回归：54 files，387 pass，0 fail，0 skip；本次定向三文件：48 pass，0 fail，0 skip。
- 真实 MySQL：loopback 临时 MySQL `8.4.11`，`REPEATABLE-READ`；五个显式测试 URL，write/R2/R3 migration history 各为 5/5。`pnpm test:mysql`：8 files，21 pass，0 fail，0 skip，TAP `181939.631ms`。
- `git diff --check`：通过。

## 未覆盖与裁决项

- 未将代表性 MySQL 证据外推为每个 R2/R3 handler 的持久化效果；该参数化 fixture 套件仍需独立补齐。
- production/quality/shipment/return/stocktake 的业务状态机细则、供应商价格/绩效、职责分离、盘点与发货/退货财务口径仍需业务裁决后再写验收测试。
- Scope B（Purchase Receipt、BOM 真实预留/领料/消耗、质检放行/隔离、真实支付、Receiver/LegalEntity）未进入测试或实现。
