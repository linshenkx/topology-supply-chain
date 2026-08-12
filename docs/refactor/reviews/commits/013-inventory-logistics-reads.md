# 提交 013：库存、发货、盘点与仓库读切片

## 提交元数据与父链

- SHA：`285d269c3922743ddc92ae4bdece1b7c2ab3044c`
- 父提交：`2f53f9b531e48fb1efd8401ea9dfe2aa1512370e`
- 主题：`feat(api): migrate inventory read endpoints`
- 提交时间：2026-08-11 16:01:39 +08:00。
- 父链：010 → 011 → 012 → 013；最终基线 `fa2581c`。

## 声明目标

迁移库存、发货、盘点、仓库 GET 的契约与 Fastify 查询，实现工厂/收货方范围，并保持写路径不动。

## 实际改动和 diff 规模

13 文件、2,218 行纯新增：4 个模块 1,067 行、4 组测试 492 行、4 份契约 620 行、barrel 39 行。与 012 一样没有 runtime/前端修改，当时尚未激活。

## 对应 docs/refactor 依据

- `01-business-baseline.md:84-112,195-201`：组织范围及 receiver 名称授权风险。
- `02-target-architecture.md:267-279`：RBAC + 数据 scope。
- `03-migration-roadmap.md:186-210`：读迁移需新旧对比与负向权限。
- `stage4-read-migration-implementation-notes.md:29-30` 明确把 receiver、仓库 scope 留作开放风险，不能据此判通过。

## 必要性与 Scope 分类

属于 Scope A。只迁查询，不负责 BOM 消耗、真实库存预留或质检放行；这些 Scope B 缺口不影响本提交的 Scope A 评价。

## 复杂度增量

- 净增 2,218 行；4 个读模型、4 契约、4 测试集。
- 无新依赖/运行组件。
- 概念增量包括工厂 warehouse scope、聚合子记录、receiver 文本 scope、固定上限和 fail-closed serializer。
- 四个相邻读域在一个提交中手写大量相似 query/mapper/bounded 逻辑，存在明显简化空间。

## 正确性、安全、权限、事务、兼容

- inventory 的工厂过滤在 SQL `WHERE factory_id = ?` 后再 LIMIT，方向正确。
- shipments 先全局取最近 200 个 shipment，再在内存按 factory 或 receiver 过滤；证据：`git show 285d269:apps/api/src/modules/shipments/index.ts` 第 169-188 行。这既可能饿死合法数据，也扩大数据库读取范围。
- receiver 授权用可变 `organizationName` 与自由文本 `destination` 相等判断，未使用稳定 receiver ID；同文件第 150-156、185-187 行。规划已把它列为高风险，但实现复制了旧复杂度。
- GET 无业务事务；授权应先于查询上限是核心正确性要求。

## 业务语义是否改变

整体保留 legacy 可见性。malformed warehouseId 后来在集成说明中列为改成 400；这属于兼容性收紧。receiver 文本授权未改变，因而旧缺陷被复制。

## 测试与证据质量

测试覆盖四域基本角色、序列化、上限和失败路径，但没有证明 receiver/factory scope 在 SQL LIMIT 前；代码反证显示未满足。切片也未集成 runtime/前端。

## 当时问题

- Important：receiver 用 `organizationName == destination` 授权，名称碰撞/变更会导致跨组织读取或拒绝；证据：`shipments/index.ts` 第 150-156、185-187 行，`01-business-baseline.md:89-94,133`。最终仍存在。
- Important：shipments 在全局 `LIMIT 200` 后才过滤外部 scope，合法主体可能得到空/陈旧窗口，且未做到授权范围内查询；证据：同文件第 169-188 行。最终仍存在。
- Minor：四域重复实现 bounded 查询/mapper/错误类，增加维护复杂度；命令证据：`git show --numstat 285d269`。

## 后续修复链

018 注册模块、切前端并补少量 malformed 参数测试；后续三个授权修复没有触及 shipments receiver。最终写迁移也没有改变该 GET 实现。

## 最终状态

库存/盘点/仓库读边界保留；receiver 文本授权和 scope-after-limit 两个 Important 仍在 `fa2581c:apps/api/src/modules/shipments/index.ts:150-188`。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**质量不足**。
- 置信度：高。
