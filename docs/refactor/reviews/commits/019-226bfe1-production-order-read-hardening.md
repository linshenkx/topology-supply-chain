# 019 · `226bfe1` 生产单读取加固审查

## 提交元数据与父链

- 完整 SHA：`226bfe1babc332c2c9e0454f9a720ca03b901a2c`
- 主题：`fix(api): secure production order read options`
- 作者/时间：linshen，2026-08-11 20:21:02 +08:00
- 父提交：`1d04a3edd4fc4a329ed3e8d90f27ac60f33dbdb7`（Stage 4 读取集成检查点）
- 后继链：`79a833a` → `8475ef4` → `9faab64` → `616c942` → `b86d9a5` → `c3a04c3` → `154f6f4` → 固定基线 `fa2581c`。

## 声明目标

提交主题及 `docs/refactor/stage4-read-migration-implementation-notes.md` 的声明是：修复生产单读取中工厂作用域候选、关联闭包和敏感内部 ID 暴露，不改变生产写语义。

## 实际改动和 diff 规模

- 3 文件，`+441/-334`：实现 `+91/-41`、契约 `+38/-12`、测试 `+312/-281`。
- 工厂候选在 SQL 中通过 `plan_items.factory_id = ?` 先过滤再 `LIMIT`；BOM 只从可见 SKU 派生。
- 对 required item/factory/BOM/purchase/component 使用精确闭包校验；公开 DTO 去除 purchase/factory/BOM/component 内部 ID，并补组件名称。

## 对应 `docs/refactor` 依据

- `stage4-read-migration-implementation-notes.md`：外部工厂必须有有效组织 ID，作用域过滤在 `LIMIT` 前执行。
- `02-target-architecture.md` 第 8.2 节、`04-production-gates.md` Gate B：数据作用域由后端查询策略强制，不能依赖前端。
- `01-business-baseline.md` 将工厂跨组织生产候选列为高风险；此提交验证并修复该声明。

## 必要性与 Scope 分类

必要，属于 Scope A 的基础授权与前后端契约最小化。没有实现 Purchase Receipt、真实 BOM 批次预留或质检放行；这些是 Scope B，不影响本提交结论。

## 复杂度增量

- 文件：无新运行组件、依赖或迁移；只修改现有 API、契约和测试。
- 代码/概念：新增 `ensureExact`、候选 SKU→BOM 二阶段查询和 summary DTO；复杂度小幅增加，主要用于 fail-closed 闭包。
- 运行成本：一次 BOM 候选查询由并行改为依赖 option items 的串行查询，换取准确作用域，规模上限固定。

## 正确性、安全、权限、事务、兼容

- 正确性：required 关联缺失或重复不再静默产出不闭合响应；最终实现见 `apps/api/src/modules/production-orders/index.ts:470-629,663-676`。
- 安全/权限：工厂候选 SQL 在 `LIMIT` 前限定工厂，BOM 限定可见 SKU；最终实现见同文件 `:482-511,582-607`。
- 事务：纯读，不新增事务问题。
- 兼容：公开契约删除多个内部 ID，属于有意安全收窄；前端消费被测试覆盖，但属于 API 响应兼容变化，应在 Stage 4/UAT 记录。

## 业务语义是否改变

没有改变生产状态机或数量规则；改变的是“可见候选”和返回字段。未授权候选从可见变为不可见，是授权修复，不是业务范围扩张。

## 测试与证据质量

- 提交新增/重写大量测试，最终态纯 API 套件中相关反例包含“无关 BOM 不能挤出授权候选”“缺失绑定先于数据库拒绝”。
- 本审查执行：API 非 MySQL 单元/契约 230/230 通过，TypeScript 通过。
- 局限：没有真实 RDS 查询计划和正式工厂 UAT；不能从单元测试推导生产容量结论。

## 当时问题

未发现可证实的 Critical/Important/Minor 当前缺陷。父提交的主要缺陷是候选/关联权限过宽，本提交本身关闭它。

## 后续修复链

后续提交没有实质修改该模块；`fa2581c` 保留本提交设计。R3 写迁移另行新增生产写处理器，不撤销读权限加固。

## 最终状态

固定基线仍正确应用工厂 SQL 作用域、闭包校验与 DTO 最小化；未发现回归。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**（修复父提交缺陷）。
- 置信度：高。证据来自父 diff、提交 diff、最终源码行和通过的反例测试。
