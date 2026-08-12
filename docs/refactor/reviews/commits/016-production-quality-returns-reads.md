# 提交 016：生产、质检与退货读切片

## 提交元数据与父链

- SHA：`a2ea165630e31238803d62631cc6f3b05f1d72de`
- 父提交：`40b2038fab6d185a2ce808b31edece59bc1e23cd`
- 主题：`feat(api): migrate production quality and returns reads`
- 提交正文声明：fail closed 工厂生产访问，并在 SQL 中限定外部质检范围。
- 提交时间：2026-08-11 17:09:59 +08:00；最终基线 `fa2581c`。

## 声明目标

迁移生产单、质检和退货 GET，修正 legacy 的 factory/supplier_qc 越权，同时保持 Scope B 的实际预留、放行和处置写闭环不变。

## 实际改动和 diff 规模

10 文件、3,766 行纯新增：生产 892、质检 324、退货 488、测试 1,185、契约 846、barrel 31。没有 runtime/前端改动。

## 对应 docs/refactor 依据

- `01-business-baseline.md:179-201,236-268`：生产/质检/库存断链是业务事实。
- `03-migration-roadmap.md:283-323`：这些写闭环应联合交付，但本段只迁 GET。
- `04-production-gates.md:77-91` 的 BIZ-001/002/003 属 Scope B，不得用来否定本读切片。
- `stage4-read-migration-implementation-notes.md:11,18,24`：外部 scope 必须先于 LIMIT。

## 必要性与 Scope 分类

读迁移及授权修复属于 Scope A。PurchaseReceipt、BOM 实物领料、质检释放/隔离是 Scope B；本提交没有误称完成这些闭环。

## 复杂度增量

- 净增 3,766 行，为本段第二大领域提交。
- 无新依赖/运行组件。
- 生产 options 闭包、BOM/PO/工厂候选、外部质检 SQL scope、退货多层 enrich 带来大量概念和查询。
- 生产模块把页面 option 构造复制进 API，初版 DTO 过宽，后续 226bfe1 大幅重写 441/334 行，说明 checkpoint 前复杂度尚未稳定。

## 正确性、安全、权限、事务、兼容

- quality 外部角色在 SQL `WHERE` 后 LIMIT，正确修复 legacy supplier_qc 全量可见问题。
- production 基础 orders 已按 factory scope，但 options 中的 PO item/BOM 候选未完全按授权工厂/SKU 闭包，后续 `226bfe1` 才加入 `authorizedFactoryId`、按 SKU 查询 BOM 和最小 DTO。
- returns 初版先全局 LIMIT 200，再加载 execution/item 后在内存过滤；还会使用与角色无关的绑定 ID。后续 `8475ef4` 才改成 role-bound scope 和 SQL EXISTS-before-LIMIT。
- GET 不承担业务事务，不能证明物料守恒或质检库存释放。

## 业务语义是否改变

质检可见性有意收紧；生产/退货目标也是收紧，但初版不完整。未改变实际生产、质检或退货状态机。

## 测试与证据质量

1,185 行测试很充足，但初版 fake database 没覆盖 option closure、role/binding 混淆和 global-noise-before-limit 反例；三个后续安全修复的新增测试证明当时 checkpoint 证据不足。

## 当时问题

- Important：生产 options 泄露未授权工厂关联的候选/BOM，并返回超出 UI 所需字段。证据：后续修复 `git show 226bfe1` 在 `production-orders/index.ts` 加 `authorizedFactoryId`、`boms.finished_sku IN (...)` 和最小 factory DTO。后续已修复。
- Important：退货先全局 LIMIT 后内存过滤，且可使用 cross-role `factoryId/supplierId` 绑定，导致数据饥饿或越权。证据：`git show a2ea165:apps/api/src/modules/returns/index.ts` 第 318-403 行；后续 `8475ef4` 改为 role-bound SQL EXISTS。后续已修复。
- Minor：892 行单文件 production read 同时承担候选闭包和序列化，明显偏重。

## 后续修复链

- `226bfe1babc332c2c9e0454f9a720ca03b901a2c`：修复 production options 授权和 DTO 最小化。
- `8475ef4b94ae34aa592a8eb26e2d064a18b6f93f`：修复 returns role-bound SQL scope-before-LIMIT。
- 018 位于两者之前，只是把初版集成；`616c942` 才在这些修复后关闭 Stage 4 门禁。

## 最终状态

上述两项 Important 在最终实现中均已修复。Scope B 业务闭环不纳入本提交结论，不能被写成当前缺陷。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**。
- 置信度：高。
