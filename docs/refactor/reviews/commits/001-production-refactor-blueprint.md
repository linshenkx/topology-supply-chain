# 001 · 生产化重构蓝图

## 提交元数据与父链

- 提交：`2523b40956443080a206552bb15343d8f1a1eba1`（`docs: define production refactor blueprint`）
- 父提交：`607cb1caac8ccfdf085795057f9bd5737f021eae`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T02:47:22+08:00`
- 审查基线：`fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`
- 命令证据：`git show --stat 2523b409`、`git diff 2523b409^ 2523b409 -- docs/refactor`

## 声明目标

冻结业务事实、目标架构、迁移路线、生产门禁和待决策项；本提交明确只做规划，不改业务代码、配置或外部环境（`2523b409:docs/refactor/00-overview.md:116`、`2523b409:docs/refactor/implementation-notes.md:5`）。

## 实际改动和 diff 规模

新增 7 份文档，`1906 insertions`、无删除：总览 122 行、业务基线 375 行、目标架构 388 行、路线图 466 行、门禁 305 行、待决策 200 行、实施笔记 50 行。没有运行时代码变化。

## 对应 docs/refactor 依据

本提交本身建立了后续事实源。关键声明是 Fastify 模块化单体、同域 `/api/v1` Strangler、Web/API/Worker 独立运行，以及先止血再迁移（`docs/refactor/02-target-architecture.md:13`、`docs/refactor/03-migration-roadmap.md:5`）。路线图也明确阶段 1 不要求提前补齐生产/质检/库存闭环（`docs/refactor/03-migration-roadmap.md:116`）。

## 必要性与 Scope 分类

形成 Scope A 的可审计边界是必要的；文档把 Purchase Receipt、BOM 实物预留/领料/消耗、质检放行/隔离列为后续联合业务波次和待决策内容，属于 Scope B，不因当时未实现判 Scope A 失败（`docs/refactor/03-migration-roadmap.md:73`、`docs/refactor/04-production-gates.md:24`）。

## 复杂度增量

- 文件/代码：+7 文档、+1906 行；运行代码为 0。
- 依赖/组件：无依赖或进程增加。
- 概念：一次引入约 10 个领域模块、四层模块结构、Worker、Outbox、writer fence、canonical command、OpenAPI/client、阶段 × Gate 和回滚等级，认知复杂度显著上升。

## 正确性、安全、权限、事务、兼容

文档正确识别身份头、客户端 Step-up、审批跨域副作用、库存/付款并发、D1/MySQL 方言和迁移历史等 P0；安全、权限、事务与兼容原则方向正确。规划不是实现证据，`pnpm audit` 数字和生产状态仍需实施时重跑/实证。

## 业务语义是否改变

没有改变运行中业务语义。目标状态机和 Purchase Receipt 等内容是建议/待批准基线，不是已交付能力；文档大体明确了这一点。

## 测试与证据质量

无应用代码变更，未跑应用测试合理。提交记录称核对 34 个 Route 文件、60 个 Handler、约 4,462 行路由和 84 张表（`docs/refactor/implementation-notes.md:46`）；独立命令核对 Route=34、表=84，与核心规模声明一致。证据主要是静态仓库审计，不能替代 MySQL/UAT/生产验证。

## 当时问题

- **Important — 阶段 2 底座出口打包过多横切能力，容易让蓝图诱发“大底座先行”。** `2523b409:docs/refactor/03-migration-roadmap.md:149-180` 同时要求 API、Worker、database/platform/test-support、模块骨架、UoW、显式 Schema、fence、幂等、Outbox、IAM、审批内核、可观测、CI 和开发编排。虽逐项合理，但缺少“按首个真实切片需要才展开”的删减准则；后续第 09 提交仅建立 API runtime，事实证明可用更小垂直切片推进。证据命令：`git show 2523b409:docs/refactor/03-migration-roadmap.md`。
- **Minor — 一处代码证据路径不自包含。** `2523b409:docs/refactor/01-business-baseline.md:125` 写成 `commit/route.ts:23-25`，实际文件是 `app/api/imports/commit/route.ts`；会降低复核可重复性，但不改变结论。

## 后续修复链

`e6f5273..7c85457` 先做窄 P0 止血；`8f57eac` 仅建独立 API runtime；`988416f` 才接入路由/部署；随后逐批迁读写。该序列部分抵消了蓝图“大底座”风险，但原文未补充显式简化准则。

## 最终状态

规划文档在最终基线仍保留。Scope B 断链被记录为业务边界而非 Scope A 失败。蓝图的架构方向得到实现验证，但复杂度偏高和证据路径简写仍存在于文档层。

## 结论与置信度

- 标签：**方向正确但实现偏重**
- 置信度：高。已核对完整文档、父基线规模、后续 23 个提交和最终实现。
