# 提交 017：供应商读切片

## 提交元数据与父链

- SHA：`014ae8e29324393c323fc56748dfedb271aee116`
- 父提交：`a2ea165630e31238803d62631cc6f3b05f1d72de`
- 主题：`feat(api): migrate supplier read endpoints`
- 提交时间：2026-08-11 17:13:38 +08:00。
- 父链：010 → … → 016 → 017；最终基线 `fa2581c`。

## 声明目标

迁移供应商档案、supplier-SKU、价格和绩效读取，按内部/工厂/供应商质检身份收窄数据。

## 实际改动和 diff 规模

4 文件、3,223 行纯新增：单个供应商模块 1,716 行、测试 916 行、契约 560 行、barrel 31 行。无 runtime/前端激活。

## 对应 docs/refactor 依据

- `01-business-baseline.md:84-112,114-143`：supplier/factory 组织关系和作用域风险。
- `02-target-architecture.md:267-279`：角色 assignment 必须与 scope 绑定。
- `05-open-decisions.md:33-47,65-71`：factory/tier 与正式角色范围尚待裁决。
- `stage4-read-migration-implementation-notes.md:24`：scope-before-LIMIT。

## 必要性与 Scope 分类

属于 Scope A 的主数据/供应商读迁移。未实现供应商业务写闭环不是缺陷。

## 复杂度增量

- 仅 4 文件却新增 3,223 行；生产模块 1,716 行，是本段最明显的单文件复杂度热点。
- 无依赖/运行组件新增。
- 一个模块同时做档案、关系、价格、绩效计算、匿名排名和导出准备，概念耦合过多；它更多是在新 API 复制旧 Workspace 聚合，而不是形成小而稳定的 Query 服务。

## 正确性、安全、权限、事务、兼容

- 初版 `dataScope` 只要 context 带有效 `factoryId` 就选 factory scope，哪怕角色不是 factory；若同时带 factory 和 supplier 角色/绑定，只取 factory，丢失合法 union。证据：`git show 014ae8e:apps/api/src/modules/suppliers/index.ts` 第 338-363 行。
- 部分绩效查询先全局读取/limit 后在内存按 visible supplier 过滤；后续 `79a833a` 将 supplier/tier/quarter 过滤推进 SQL。
- 绩效匿名化和 rank 是业务语义，不应因页面需要而泄露其他供应商身份；初版测试未覆盖混合角色/伪绑定。

## 业务语义是否改变

目标是按组织范围收紧并提供匿名排名。后续修复保留该目标，调整 mixed-role union 和查询顺序，没有引入新供应商业务流程。

## 测试与证据质量

916 行测试覆盖大量 DTO/计算，但缺失 receiver 带伪 factoryId、factory+supplier 混合角色、历史季度全局噪音等反例。`79a833a` 新增 224 行测试正说明原 checkpoint 质量不足。

## 当时问题

- Important：scope 由存在的绑定 ID 而不是持有对应角色决定，且 mixed roles 不做 union；可造成越权或漏数。证据：初版第 338-363 行；`git show 79a833a` 将其改为 `hasFactoryRole/hasSupplierRole` 和 `factory_supplier`。后续已修复。
- Important：绩效 delivery/review 的 quarter/tier/visible supplier 过滤未完整位于 LIMIT 前，合法数据可被全局噪音挤出。证据：`git show 79a833a` 新增 `supplier_id IN (...)`、tier 和 quarter-before-LIMIT 测试。后续已修复。
- Minor：1,716 行单模块承载四个子域，属于明显简化候选。

## 后续修复链

`79a833a70f3430249fd20158f65b4bd6b54ec9aa` 在 018 后修复角色绑定、mixed-role union、SQL scope/quarter/tier 顺序，并补充负向/噪音测试；最终基线保留该修复。

## 最终状态

两项授权/可用性 Important 已修复。单文件聚合复杂度仍高，建议按 supplier profile、commercial relation、performance query 拆内部纯函数/Query repository，而不是拆新运行服务。

## 结论与置信度

- 标签：**可明显简化**、**后续已修复**。
- 置信度：高。
