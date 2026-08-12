# 提交 012：财务与审批读切片

## 提交元数据与父链

- SHA：`2f53f9b531e48fb1efd8401ea9dfe2aa1512370e`
- 父提交：`6b0d6ce6007d6459a310ebfc2134d7960c49299e`
- 主题：`feat(api): migrate finance and approvals reads`
- 提交时间：2026-08-11 15:17:38 +08:00。
- 父链：010 → 011 → 012；最终基线 `fa2581c`。

## 声明目标

把财务工作台和审批列表的只读数据模型、契约及权限负向测试移入 Fastify，保留写路径在 legacy。

## 实际改动和 diff 规模

7 文件、1,950 行纯新增：财务模块 540、审批模块 203、测试 738、契约 446、barrel 23。该提交没有修改 `runtime.ts` 或前端，所以当时只是可集成切片，尚未实际对外生效。

## 对应 docs/refactor 依据

- `01-business-baseline.md:203-283`：财务/审批语义和敏感性。
- `02-target-architecture.md:219-289`：契约与授权范围。
- `03-migration-roadmap.md:186-210`：低风险读迁移方法。
- `stage4-read-migration-implementation-notes.md:12,25`：保留单公司内部范围、`bankReference` 为待 UAT 项；这是风险披露而非证明。

## 必要性与 Scope 分类

属于 Scope A 的读边界迁移。没有补全真实支付或发票业务闭环，不能因 Scope B 未实现判失败。

## 复杂度增量

- 净增 1,950 行，2 个模块、2 份契约、2 组测试。
- 依赖和运行组件：无。
- 概念：9 组财务表聚合、固定角色白名单、响应行强校验、读审计。
- 多表查询/手写 mapper 基本复制了旧工作台聚合复杂度，只是加上 schema 和 fail-closed 校验；方向合理但维护面显著增加。

## 正确性、安全、权限、事务、兼容

- finance/approvals 仅允许 `admin/supply_chain/finance`，未授权时不访问数据库；证据：`git show 2f53f9b:apps/api/src/modules/finance/index.ts` 第 21、457-458、514-535 行，approvals 第 13、119-130、188-199 行。
- 授权只有角色，没有 legal entity/factory 数据范围；Stage 4 文档把它描述为“single-company internal scope”，属于有意识延期，而非完整目标权限模型。
- 财务响应保留银行流水号；证据：`packages/contracts/src/finance.ts` 第 46、222-231 行。其必要性来自当前 UI，但仍是敏感字段最小化风险。
- GET 写审计，因而不能做无副作用在线 shadow；事务性不适用于聚合读，但审计失败会令读失败，选择了审计完整性优先。

## 业务语义是否改变

目标是兼容旧工作台；未改变付款、发票、审批状态机。字段最小化删除了无消费者敏感字段，但保留 `bankReference`。

## 测试与证据质量

738 行测试覆盖角色拒绝、查询上限、映射/空值、数据库错误和审计。缺少前端/运行时集成，且没有 legal-entity 范围 fixture；因此切片级证据足够，迁移完成证据不足。

## 当时问题

- Important：财务和审批只做粗角色授权，没有按 legal entity/组织 scope 过滤；若单公司假设不成立会越权。证据：`finance/index.ts` 第 391-435 行查询均无 scope 参数，`assertAllowed` 第 457-460 行只看角色；`05-open-decisions.md:95-100` 的 D-10 尚未裁决。最终仍保持这一 Scope A 风险。
- Minor：`bankReference` 对三个内部角色完整返回，缺字段级 capability。证据如上；最终仍存在。

## 后续修复链

018 把两个模块注册到 runtime 并切换前端 GET，同时为读审计提供共享 writer；未见 legal entity scope 或 `bankReference` capability 修复。Stage 5/后续写提交处理的是写安全，不能视为读范围修复。

## 最终状态

模块已实际接入且测试保留；粗粒度内部角色模型和银行流水号披露仍在最终基线。若部署仍是单公司，风险受业务假设约束，但该假设尚非强模型。

## 结论与置信度

- 标签：**方向正确但实现偏重**。
- 置信度：高（代码事实高；业务单公司假设为中等）。
