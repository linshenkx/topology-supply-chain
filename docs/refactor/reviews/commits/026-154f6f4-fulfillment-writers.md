# 026 · `154f6f4` 履约写迁移审查

## 提交元数据与父链

- 完整 SHA：`154f6f452487300921da675fabda94ceb23ea765`
- 主题：`feat: migrate fulfillment writes to Fastify v1`
- 作者/时间：linshen，2026-08-12 06:48:43 +08:00
- 父提交：`c3a04c3b0bc847851be0c739a761ad0970de1a99`
- 后继：固定基线 `fa2581c`。

## 声明目标

迁移 approvals、库存/调拨、生产、质检、盘点、发货、退货、财务和仓库的现有写语义到 Fastify v1；旧写端点退役；明确测试 R3 不越入 Scope B。

## 实际改动和 diff 规模

- 50 文件，`+4,757/-99`。
- 新增约 3,247 行 R3 handler/support/manifest/command，960+ 行测试/契约，13 个 route-method command。
- 旧 Next 写方法和 v1 bridge 前端切换；新增 R3 migration 草案和孤立 Worker domain event contract。

## 对应 `docs/refactor` 依据

- Stage 5 T3–T5 现有写迁移部分；`03-migration-roadmap.md` Stage 6/7。
- 用户统一边界明确：Scope A 只迁现有语义；Receipt、真实 BOM 批次预留/领料/消耗、质检放行/隔离属于 Scope B。

## 必要性与 Scope 分类

把现有履约写端点迁到独立 API 是 Scope A。提交测试明确禁止引入 `purchase_receipt/material_issue/material_consumption/quality_release` 等 Scope B 表，这是边界意识的正面证据。

## 复杂度增量

- 单目录 8 个 R3 文件、约 3,247 行；Finance 595 行、Approvals 576 行、Inventory 636 行、Logistics 535 行，仍然偏大。
- `finance.command`、`returns.command`、`logistics.shipment.command` 继续 action multiplexing，与计划“显式命令子资源”不一致。
- R3 复制了又一套 command executor（156 行），与平台/R2 重复。
- 新增 migration/Worker integration hook 但未真正接线，导致提交当时不是可独立部署闭环。

## 正确性、安全、权限、事务、兼容

- 正面：Same-Origin/CSRF、幂等、事务、版本锁、数据库唯一键、审计/Outbox 和旧端点 410。
- 权限：handler 内按 role/factory/file scope 检查；审批 effect 与 claim 同事务。
- 兼容：保留 action-multiplexed body，有利于前端迁移但使 fence/契约粒度粗。
- Scope B 保持旧语义：例如最终 `production-handlers.ts:109-114` 仍把理论量记入 `reserved_quantity`，并非真实库存 reservation；不应宣称实物闭环完成。

## 业务语义是否改变

写所有者和技术不变量改变；尽量保留 legacy 业务语义。新增 payable domain event/版本锁等是安全性强化。未实现 Scope B，不计失败。

## 测试与证据质量

- 新增 672 行真实 MySQL migration 测试和 190 行边界测试；最终纯套件 230/230 通过。
- 测试“R3 stays inside Scope A”有效防止越界，但不能证明生产、质检、库存业务闭环。

## 当时问题

- **Important — 领域 Outbox topic 与 Worker/正式 migration 未接通，提交不可独立运行。** 当时 `support.ts` 以 `"r3.domain-event" as never` 绕过共享 topic union，Worker 只有孤立 `apps/worker/src/r3/domain-events.ts` validator，主 Worker switch 不消费；migration 文件名 `drizzle-mysql/r3_scope_a_fulfillment_writes.sql` 也不符合 journal 数字序列。证据：`git show 154f6f4:{apps/api/src/r3/support.ts,apps/worker/src/r3/domain-events.ts,drizzle-mysql/r3_scope_a_fulfillment_writes.sql}`。
- **Minor — R3 fence 粒度粗于规划。** 13 个 command 映射为 10 个领域/Route resources，且 finance/returns/shipment 内多个 action 共用一个 command/fence；最终仍见 `packages/contracts/src/r3-fulfillment-writes.ts:3-35`。

## 后续修复链

- **第一项已由提交 27 修复。** topic 统一为 `domain.event`，Worker 主 switch 增加 schema/recipient 处理，R3 migration 改为 `0004_scope_a_domain_writes.sql` 并进入 journal。
- fence 粗粒度最终仍存在，并被全量激活脚本放大。

## 最终状态

R3 运行接线已闭合到“代码可运行”层面；Scope B 仍明确未实现。粗 command/fence、分波 UAT、生产切写和回滚仍未闭环。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**、**可明显简化**。
- 置信度：高。
