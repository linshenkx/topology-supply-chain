# 020 · `79a833a` 供应商读取作用域加固审查

## 提交元数据与父链

- 完整 SHA：`79a833a70f3430249fd20158f65b4bd6b54ec9aa`
- 主题：`fix(api): harden supplier read scopes`
- 作者/时间：linshen，2026-08-11 20:25:47 +08:00
- 父提交：`226bfe1babc332c2c9e0454f9a720ca03b901a2c`
- 后继链：`8475ef4` → `9faab64` → `616c942` → `b86d9a5` → `c3a04c3` → `154f6f4` → `fa2581c`。

## 声明目标

收紧供应商档案、SKU/价格和绩效读取的数据范围，拒绝无有效绑定的外部角色，并让混合 `factory + supplier_qc` 角色按两个有效绑定取并集。

## 实际改动和 diff 规模

- 2 文件，`+422/-83`；实现 `+198/-74`，测试 `+224/-9`。
- 删除 `empty` 静默空结果，改为 403 fail closed；新增 `factory_supplier` scope。
- 绩效 review/delivery 查询改为先限定活跃供应商、季度及 visible supplier IDs，再应用上限；上海季度边界显式化。
- 敏感评论按调用者作用域决定是否揭示。

## 对应 `docs/refactor` 依据

- `stage4-read-migration-implementation-notes.md`：外部角色必须有有效组织绑定，作用域在 SQL/`LIMIT` 前执行。
- `01-business-baseline.md` 角色矩阵、`02-target-architecture.md` 第 8.2 节、`04-production-gates.md` Gate B：RBAC + 数据范围且后端强制。

## 必要性与 Scope 分类

属于 Scope A 权限/安全加固。它没有补供应商主数据审批、价格版本业务或绩效自动指标；这些不应从读权限提交推断完成。

## 复杂度增量

- 无新文件、依赖、迁移或运行组件。
- 新增四态 scope union、季度边界和 visible-ID 查询闭包；概念复杂度中等，但与混合角色现实模型一致。
- 测试增量接近实现增量，证据密度较好。

## 正确性、安全、权限、事务、兼容

- 权限：无本角色绑定的外部用户在任何业务查询前 403；最终证据 `apps/api/src/modules/suppliers/index.ts:359-390`、测试 `apps/api/test/suppliers.test.mjs:338-369`。
- 正确性：历史季度只统计该季度 delivery，且 review/delivery 均闭合在 visible supplier ID。
- 事务：纯读；敏感价格读取仍要求审计端口。
- 兼容：原来的“无绑定返回空数组”变为 403，是明确安全兼容变化；混合角色从单一绑定优先级变为并集，属于授权语义修正。

## 业务语义是否改变

改变可见性而非供应商业务状态。绩效季度口径从可能跨季度污染改为上海时区季度边界，是正确性修复，但应由业务 UAT确认上海时区口径。

## 测试与证据质量

- 最终相关测试覆盖 403、混合角色、`LIMIT` 前过滤、匿名排行、季度语义和 XLSX 同作用域。
- 本审查 API 纯测试 230/230 通过；未运行真实 MySQL 数据量/查询计划测试。

## 当时问题

未发现提交自身可证实的未修 Critical/Important/Minor。代码中工厂档案查询没有额外 `status='active'`，但这是保留自身组织档案的兼容选择，现有文档不足以把它定性为缺陷。

## 后续修复链

后续未改此模块；最终态保留 scope union、季度过滤和 fail-closed 行为。

## 最终状态

权限加固仍在固定基线中，且单元/契约反例通过。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**（修复父阶段读范围缺陷）。
- 置信度：高。
