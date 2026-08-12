# 003 · 库存调拨原子化

## 提交元数据与父链

- 提交：`9b25fe8d3ceb592c3da5475e72c9de13485c37c0`（`fix: make inventory transfers atomic`）
- 父提交：`e6f527365f80c9b6ae68fbb7805e481cb0ceb71a`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T03:24:20+08:00`
- 命令证据：`git diff 9b25fe8^ 9b25fe8`；最终对照：`git diff 9b25fe8 fa2581c -- app/api/inventory/transfers/route.ts`

## 声明目标

用状态 CAS、条件扣库和生产 MySQL 事务阻止调拨重复发出/收货及负库存。

## 实际改动和 diff 规模

4 文件，`176 insertions / 11 deletions`。路由净增 40 行；新增 37 行扣减规划 helper、83 行测试、5 行笔记。

## 对应 docs/refactor 依据

CONSISTENCY-001 要求 2/10/50 并发只有一次有效状态转换，库存不负且数据库条件兜底（`docs/refactor/04-production-gates.md:50-53`）；阶段 1 要调拨原子状态转换和 MySQL 并发证据（`docs/refactor/03-migration-roadmap.md:128`）。

## 必要性与 Scope 分类

调拨账实一致性是 Scope A P0 止血。它不补 BOM 预留、领料、消耗或质检放行，因此不越入 Scope B。

## 复杂度增量

一个小型纯函数 helper；无依赖/Schema/组件增加。将更新拆为“状态抢占→逐批条件扣减→流水”增强了概念但与原子性要求匹配。

## 正确性、安全、权限、事务、兼容

发出与收货均先用旧状态条件抢占；每批扣减带 `available >= deduction`，任一步失败应由 MySQL 事务回滚。原权限检查保持。D1 预览事务语义不足，提交已明确生产保证只针对 MySQL。

## 业务语义是否改变

正常调拨语义不变；并发重复由可能二次生效改为 409。FEFO 排序沿用原实现。

## 测试与证据质量

5 个测试验证状态表、扣减算法和源码顺序/谓词；没有真实双连接 MySQL 测试，因此能证明意图与纯逻辑，不能单独证明驱动回滚和锁等待行为。

## 当时问题

- **Important — 业务事务与审计仍可分裂。** `9b25fe8:app/api/inventory/transfers/route.ts:82-136` 在事务内完成状态、库存、movement，但 `writeAudit` 在事务提交后的第 138 行执行。审计失败会返回 500，而调拨已生效；重试又会因状态 CAS 返回 409，留下不可补写的审计缺口。问题不是 CAS 本身错误，而是提交未达到规划要求的“状态/流水/审计同生共死”。

## 后续修复链

`154f6f4` 迁移调拨写到 Fastify；最终 `apps/api/src/r3/inventory-handlers.ts:190-258` 使用 `FOR UPDATE`、状态条件、source key、版本与事务内 `audit(command.transaction, ...)`，旧路由返回 410（`app/api/inventory/transfers/route.ts:29,61`）。

## 最终状态

当时审计缺口已由后续迁移关闭；第 03 提交的 CAS/条件扣减方向被保留并加强。没有把 Scope B 实物闭环缺失算作本提交缺陷。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**
- 置信度：高。
