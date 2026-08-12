# 027 · `fa2581c` Scope A 写迁移最终集成审查

## 提交元数据与父链

- 完整 SHA：`fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`
- 主题：`feat: complete scope a write migration`
- 作者/时间：linshen，2026-08-12 13:12:54 +08:00
- 父提交：`154f6f452487300921da675fabda94ceb23ea765`
- 本提交即统一审查固定基线；没有后续修复提交。

## 声明目标

完成 Scope A 写迁移集成：把 R2/R3 migration 纳入正式 journal，接通通用 domain-event Worker，补 import evidence 所有权、注册/运行时接线、部署 fence 和生产安全测试，并将页面剩余写入口切到 v1。

## 实际改动和 diff 规模

- 32 文件，`+12,949/-533`；新增 `0004_snapshot.json` 约 12,041 行，排除生成快照/锁文件后实际代码与测试增量较小。
- 删除孤立 R2 fence SQL、R3 Worker contract 与非序号 migration，合并到 `0004_scope_a_domain_writes.sql`。
- Worker 新增约 133 行 `domain.event` recipient dispatch；导入/采购文件绑定到 `import_upload + userId`。
- 生产部署脚本/测试扩充为自动激活全部 R2/R3 fence，回滚增加 generation-aware 检查。

## 对应 `docs/refactor` 依据

- `stage5-write-migration-plan.md` T1–T5、逐 command runbook 与 Scope A/B 边界。
- `02-target-architecture.md` writer fence、Outbox、首次 v1 写后回滚限制。
- `03-migration-roadmap.md` 要求真实切写按采购→实物联合波次→物流→财务串行，并在每波做 canonical/账实对账。
- `04-production-gates.md` MIG-001/MIG-002、Gate C/D/E。

## 必要性与 Scope 分类

本提交修复前两提交的集成断点，属于 Scope A 必要收尾。它没有实现 Purchase Receipt、真实 BOM lot reservation/issue/consume、质检放行/隔离；这些 Scope B 缺口不作为 Scope A 失败。问题在于部署脚本仍自动激活包含这些现有语义的所有领域 writer，使“代码迁移完成”容易被误读为“业务波次/UAT 完成”。

## 复杂度增量

- 最终 19–27 相对 Stage 4 父基线共 193 文件、`+54,891/-3,731`；排除 docs、迁移快照/锁文件后，约实现 `+13,027/-2,475`、测试 `+5,104/-504`。
- 运行组件由 Web/API 扩展为 Web/API/Worker/migrator；控制面包括三套 command executor（platform/R2/R3）、31 个 fence resource、Outbox、Step-up、resource version、R2/R3 manifest。
- 最终集成消除若干临时文件，但没有消除重复 executor、action multiplexing 和粗 R3 fence，净复杂度仍显著上升。

## 正确性、安全、权限、事务、兼容

- 正面：R2 import file 所有权已修；R3 event schema/recipient 进入 Worker 主循环；正式 migration 顺序完整；旧 writer 测试为 410；事务/幂等/审计/Outbox 局部边界完整。
- 安全：API/Worker secret 隔离、CSRF/Origin、Step-up 与文件 clean/entity scope 均有负向测试。
- 事务：领域命令在 MySQL UoW 内提交，未知结果 fail closed。
- 兼容/发布：历史迁移 hash、全量 fence 激活和回滚判断仍有下述最终缺陷。

## 业务语义是否改变

最终态迁移的是现有写语义，并新增事务、幂等、异步通知等安全语义。Scope B 的实物链没有补齐：例如 `apps/api/src/r3/production-handlers.ts:109-114` 仍把理论量写进生产物料行的 `reserved_quantity`，没有创建真实库存 reservation；不得将提交标题解释为采购到付款业务闭环完成。

## 测试与证据质量

- 本审查实际通过：Contracts/API/Worker TypeScript；API 非 MySQL 单元/契约 230/230；部署边界 15/15；Worker 非集成 5/5。
- 4 个 Worker 真实 MySQL 集成因未配置 `MYSQL_WRITE_TEST_URL` 跳过；API MySQL integration 亦未在本审查环境执行。
- 标准 `pnpm --filter @topology/api test` 在依赖状态检查阶段因 `pnpm-workspace.yaml:1-2` 的基线遗留 `allowBuilds` 占位值失败，未进入测试；直接已安装入口通过。
- 测试 `tests/api-deployment-boundary.test.mjs` 反而断言“激活 every domain fence”，证明脚本结构符合当前实现，却没有证明规划要求的分波 UAT/对账。

## 当时问题

- **Important — 发布脚本绕过逐 command/逐业务波次切写协议，自动一次性激活全部 writer 与 Worker。** `deploy/aliyun/deploy.sh:36-43` 停全服务、跑迁移后直接调用 `set-writer-fences.mjs`；该脚本 `:2-19` 一次更新 31 个资源。`check-write-drain.mjs:4-15` 只检查 processing outbox 和 pending/unknown idempotency，既无 legacy→blocked epoch/owner 转换，也无业务表、ledger、audit、outbox 的 canonical 对账，更无采购/实物/物流/财务签字 UAT。它直接违反 `stage5-write-migration-plan.md:10,191-201,257,274`。最终仍存在。
- **Important — 回滚安全检查漏算 R2/R3 领域事实，并对所有“带 Worker 的目标镜像”跳过检查。** `deploy/aliyun/rollback.sh:49-62` 只有目标镜像不存在 Worker 时才运行检查；`scripts/check-legacy-rollback-safety.mjs:24-28` 的事实列表仅含平台认证/用户/文件/通知命令，漏掉采购、库存、生产、物流、财务等 R2/R3 command。产生领域事实后回滚到提交 24 这类已带 Worker、但业务 legacy writers 尚未退役的版本，脚本可直接启动旧业务 writer，违背首次 v1 写后的 forward-fix 规则。最终仍存在。
- **Important — 既有 MySQL 环境的普通追加升级仍被改写历史 migration 阻断。** 提交 24 改写 0000/0001，本提交未恢复；`scripts/check-mysql-migration-history.mjs:35-49` 对旧 hash 必然 fail closed。README 提供人工受控路径是安全止损，不是可重复升级闭环。最终仍存在。
- **Minor — R3 fence/command 粒度弱于批准计划。** `packages/contracts/src/r3-fulfillment-writes.ts:3-35` 把 13 个 route-method command 映射到 10 个资源，且 finance/returns/shipment 内多个 action 共用粗 command。它无法独立冻结 `record_payment` 而保留低风险 finance action，和计划明确“不能只用 finance 粗开关”不一致。
- **Minor — 标准测试命令的干净环境复现仍失败。** 证据命令：`pnpm --filter @topology/api test`；pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，根因是 `pnpm-workspace.yaml:1-2` 的占位策略。该配置源于初始基线而非本范围引入，但“complete”提交没有关闭生产门禁的可复现性缺口。

## 后续修复链

无后续提交。提交 27 自身修复了提交 25 的 import file ownership 与提交 26 的 migration/Worker 接线；上述五项残余均留在固定基线。

## 最终状态

代码级写迁移和本地边界测试已形成可运行闭环，旧写入口大多已退役；生产切写、既有库升级和安全回滚没有形成与规划一致的可审计闭环。因此“complete scope a write migration”可理解为源码集成完成，不能理解为生产 Gate/业务 UAT 完成。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**质量不足**、**可明显简化**。
- 置信度：高。三个 Important 均由最终脚本/迁移/提交链直接证明；真实生产环境未连接，因此不声称已发生事故。
