# 021 · `8475ef4` 退货读取授权闭环审查

## 提交元数据与父链

- 完整 SHA：`8475ef4b94ae34aa592a8eb26e2d064a18b6f93f`
- 主题：`fix(api): close returns read authorization scope`
- 作者/时间：linshen，2026-08-11 20:33:28 +08:00
- 父提交：`79a833a70f3430249fd20158f65b4bd6b54ec9aa`
- 后继链：`9faab64` → `616c942` → `b86d9a5` → `c3a04c3` → `154f6f4` → `fa2581c`。

## 声明目标

把退货外部授权从“先取全局最新 200 条再在内存过滤”改为数据库先按 factory/supplier 关系过滤，并拒绝借用无对应角色的组织 ID。

## 实际改动和 diff 规模

- 2 文件，`+261/-126`；实现 `+81/-93`，测试 `+180/-33`。
- 用 `ReturnsScope` 取代松散 `ensureRole/isInternal + nullable IDs`。
- 将 factory/supplier/mixed scope 写入父查询的 `EXISTS`，再排序与 `LIMIT`；删除额外 execution/item 全量闭包查询。
- 子 inspections/dispositions 只对已授权退货 ID 查询。

## 对应 `docs/refactor` 依据

- `stage4-read-migration-implementation-notes.md` 明确授权过滤必须先于上限。
- `01-business-baseline.md` 将外部角色跨组织访问列为 Gate B 重点；`04-production-gates.md` 要求替换 URL/Body ID 的负向测试。

## 必要性与 Scope 分类

必要的 Scope A 授权修复。退货处置、回库和财务后果的完整闭环属于 Scope B/后续业务验收，本提交不宣称完成。

## 复杂度增量

- 无新依赖/组件/迁移。
- 总实现净减少 12 行；把多段内存过滤换成一个按 scope 构造的 SQL `EXISTS`，概念更直接、查询次数更少。
- 测试净增 147 行，覆盖授权饥饿和 spoofed binding。

## 正确性、安全、权限、事务、兼容

- 最终 SQL 证据：`apps/api/src/modules/returns/index.ts:321-375`；授权在 `LIMIT` 前。
- 子记录闭包：同文件 `:396-426`。
- 无对应角色却携带 factory/supplier ID 会在数据库前拒绝：`:283-305`。
- 纯读无事务变化。403 取代部分旧空结果是有意安全收窄。

## 业务语义是否改变

只改变可见性和结果窗口：外部角色现在得到“自己范围内最新 200 条”，而非“全局最新 200 条中过滤后的子集”。这是正确性与可用性修复。

## 测试与证据质量

- 最终测试覆盖 factory、supplier、mixed union、无绑定、伪造绑定、全局噪音超过上限以及子记录越界 fail closed。
- 本审查 API 纯测试 230/230 通过；没有真实 MySQL explain/容量证据。

## 当时问题

未发现提交自身仍存在的可证实 Critical/Important/Minor。

## 后续修复链

后续未改读模块；提交 26 只迁退货写路径，不撤销读授权。

## 最终状态

固定基线仍维持 SQL 前置过滤和严格组织绑定。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**（修复 Stage 4 当时问题）。
- 置信度：高。
