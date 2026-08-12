# 提交 014：采购与导入读切片

## 提交元数据与父链

- SHA：`40ea06bd29ea2871b0f812f53630282b86c0eeaf`
- 父提交：`285d269c3922743ddc92ae4bdece1b7c2ab3044c`
- 主题：`feat(api): migrate purchase and import reads`
- 提交时间：2026-08-11 16:25:35 +08:00。
- 父链：010 → 011 → 012 → 013 → 014；最终基线 `fa2581c`。

## 声明目标

迁移采购计划、采购单和导入差异 GET，尤其修正工厂只看自身 allocation 的数据范围；写仍留 legacy。

## 实际改动和 diff 规模

10 文件、2,993 行纯新增：3 模块 1,380 行、3 测试 985 行、3 契约 600 行、barrel 28 行。无 runtime/前端切换，仍为集成切片。

## 对应 docs/refactor 依据

- `01-business-baseline.md:144-178`：计划/采购单多工厂风险。
- `03-migration-roadmap.md:186-210,252-279`：先验证读范围，Receipt 仅契约准备、实物切写属后续波次。
- `stage4-read-migration-implementation-notes.md:18-25`：工厂 PO 只见 allocation，scope 先于 LIMIT。
- `stage5-write-migration-plan.md:112-117` 是后续写计划，不能反推本读切片已实现 Receipt。

## 必要性与 Scope 分类

采购读迁移属于 Scope A。PurchaseReceipt 聚合和真实库存到货属于 Scope B/后续联合波次；本提交不实现它并非缺陷，若文档把 GET 切片描述成采购闭环才算越界。本提交文档未作该声明。

## 复杂度增量

- 净增 2,993 行，3 模块/3 契约/3 测试。
- 无依赖/运行组件增量。
- 概念：计划 header/工厂子状态、PO allocation 投影、导入 staging/diff、闭合集合和固定上限。
- 采购单模块 568 行、测试 399 行是为了避免整单泄漏而产生的必要复杂度；但与 legacy 并存且手写 DTO，净复杂度仍很高。

## 正确性、安全、权限、事务、兼容

- 工厂 PO 使用 SQL EXISTS/plan item factory scope，并仅组合自身链接、重算可见数量与金额；最终证据在 `apps/api/src/modules/purchase-orders/index.ts:340-505`。
- 工厂 scope 无有效 `factoryId` 时 fail closed；内部角色保留全局读取。
- imports 只读取 diff/staging，不宣称 commit 能力；符合读阶段边界。
- GET 无事务问题；多查询快照可能在并发写期间不一致，未使用一致性事务。对工作台读可接受，但不能作为对账 oracle。

## 业务语义是否改变

有意修正 legacy：工厂不再看到含其他工厂 allocation 的整单明细，总额由可见 allocation 重算。这是安全收紧，可能改变 UI 数字含义，需 UAT。

## 测试与证据质量

985 行测试覆盖工厂/内部角色、多工厂 allocation、坏数据、上限和导入筛选，证据密度高。缺少真实 MySQL 查询计划、新旧对账样本和当时 runtime/前端集成。

## 当时问题

- Minor：三个大模块仍以固定全量快照和多查询组装为主，未提供游标/一致快照；命令证据 `git show --numstat 40ea06b`，最终风险保留。
- Minor：目标契约要求生成 Client，但本提交只有 schema/interface，尚无消费者；该跨段根因在 011 已计数，此处不重复计入问题统计。

## 后续修复链

018 注册三个模块并把 `PurchaseWorkspace` GET 切到 v1，补 contract nullability；最终写迁移另行实现 writer/幂等。未发现需要针对采购读授权的后续安全修复。

## 最终状态

工厂 PO allocation 收窄逻辑保留且未见回归。PurchaseReceipt/BOM 库存等仍不属于本提交验收范围。读快照的分页/一致性局限仍在。

## 结论与置信度

- 标签：**方向正确但实现偏重**。
- 置信度：高。
