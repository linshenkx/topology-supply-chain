# 022 · `9faab64` Stage 5 写迁移计划审查

## 提交元数据与父链

- 完整 SHA：`9faab6465baa244462409409f0b01c6875c8482c`
- 主题：`docs: plan stage5 write migration`
- 作者/时间：linshen，2026-08-11 20:33:28 +08:00
- 父提交：`8475ef4b94ae34aa592a8eb26e2d064a18b6f93f`
- 后继链：`616c942` → `b86d9a5` → `c3a04c3` → `154f6f4` → `fa2581c`。

## 声明目标

以 `1d04a3e`/Stage 4 为事实基线，为写迁移提供可派发控制面、旧端点映射、五任务拆分、逐命令切写 runbook 和 UAT oracle；该提交自称“计划，不是已完成声明”。

## 实际改动和 diff 规模

- 2 个 docs-only 新文件，`+313/-0`。
- 定义 transaction UoW、canonical idempotency、用例级 writer fence、Outbox、Step-up、文件状态机和 approval effect port。
- 把 T1–T5 可并行开发但真实切写按采购→实物→物流→财务串行；明确 Scope B 的 Receipt/BOM 预留/质检处置为联合波次。

## 对应 `docs/refactor` 依据

承接 `00-overview.md`、`02-target-architecture.md`、`03-migration-roadmap.md`、`04-production-gates.md` 与 `05-open-decisions.md`。计划中的控制表与这些文档方向一致，且准确写明开放业务决策。

## 必要性与 Scope 分类

必要的规划提交，但对 Scope A 来说偏重：它把最小前后端分离/安全修复与生产级 Worker、Outbox、逐命令 fence、完整 UAT 平台同时设为硬前置。作为长期目标合理，若被解释为一次 Scope A 实现清单，会放大交付与审查面。

## 复杂度增量

- 代码/运行时为零，但概念一次新增：5 任务、约 37 写方法映射、7 步 runbook、十余类 UAT、Worker/Outbox/fence/Step-up/file/approval 控制面。
- 文档把每个 canonical command 的 fence 粒度写成硬规则，后续实现若采用粗粒度必须显式偏差评审。

## 正确性、安全、权限、事务、兼容

计划对事务、幂等、权限、Step-up 和回滚边界的要求严谨；关键正确点是明确禁止粗 Route fence、禁止一次业务事实依赖最终一致性、首次 v1 写后禁止无证明回切 legacy。

## 业务语义是否改变

文档提出多工厂派生状态、Receipt、部分放行、法律主体和外部支付边界，但都标为推荐/待裁决。计划本身没有改变运行语义。

## 测试与证据质量

文档提交的端点/引用/表格审计充分，但“未来 UAT 列表存在”不是实现证据。后续实际提交没有交付计划所列业务签字、全链 oracle 和分波激活证据。

## 当时问题

- **Minor — Scope A 与完整生产平台边界不够醒目。** 文档虽说 T3/T4/T5 有依赖，却把 Stage 5 标题下的五任务均列为用户可见交付，容易被后续实现当作一次性 Scope A 完成清单。证据：`docs/refactor/stage5-write-migration-plan.md:177-189`。

## 后续修复链

- 提交 24–27 实现了大部分平台与 writer；但没有更新本文记录偏差。
- 最终实现把 R3 多个 command 映射到领域/Route 粗 fence（`packages/contracts/src/r3-fulfillment-writes.ts:21-35`），并由部署脚本一次性全启用，直接违反本文 `:191-201,274` 的逐命令串行协议。

## 最终状态

计划作为长期目标仍有价值；但最终代码没有真实闭合计划中的签字 UAT、逐命令对账/激活和回滚证明。把提交 27 标为“complete scope a write migration”时必须附带这一差距，不能用本文存在替代验证。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**可明显简化**。
- 置信度：高。
