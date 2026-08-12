# 段落 03 · 加固与 Scope A 写迁移（提交 19–27）

## 审查范围与方法

本段覆盖 9 个连续提交：`226bfe1`、`79a833a`、`8475ef4`、`9faab64`、`616c942`、`b86d9a5`、`c3a04c3`、`154f6f4`、`fa2581c`。固定实现基线为 `fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`。

每个提交均同时核查父提交、该提交 diff、其后修复和最终实现；`docs/refactor` 仅作为待验证声明。Scope B 的 Purchase Receipt、真实 BOM 批次预留/领料/消耗、质检放行/隔离未实现，不计为 Scope A 失败。

## 总结统计

- 提交数：9（实现/加固 8，纯规划 1）。
- 产物：9 份逐提交审查 + 本段总结。
- 代码趋势：相对 Stage 4 检查点父提交共 193 文件、`+54,891/-3,731`；其中 docs `+313`，迁移快照/锁文件约 `+36,447/-752`，排除生成物后实现约 `+13,027/-2,475`、测试约 `+5,104/-504`。
- 净复杂度：显著上升。新增 Worker、四类控制表、31 个 fence resource、三套 command executor、R2/R3 manifest、文件扫描/Step-up/Outbox/部署与回滚控制面；旧 Next writer 大量删除，部分抵消维护面。
- 本范围引入问题（根因去重）：Important 5 项，其中 2 项后续已修复、3 项最终未修；Minor 3 项，均最终未修/未澄清。
- 另外，提交 19–21 修复了 Stage 4 父基线的 3 组重要读权限/授权饥饿问题；不把它们重复计作本范围“引入问题”。

## 提交结论矩阵

| # | SHA | 主要结论 | 标签 | 当时/最终问题 |
| --- | --- | --- | --- | --- |
| 19 | `226bfe1` | 工厂生产候选 SQL 前置过滤、闭包和 DTO 最小化 | 必要且克制 / 后续已修复 | 未发现本提交残余 |
| 20 | `79a833a` | 供应商混合角色、季度与敏感评论作用域收口 | 必要且克制 / 后续已修复 | 未发现本提交残余 |
| 21 | `8475ef4` | 退货授权移入父 SQL，避免全局 `LIMIT` 饥饿 | 必要且克制 / 后续已修复 | 未发现本提交残余 |
| 22 | `9faab64` | 计划严谨，但把长期生产平台与 Scope A 一次性交付绑定过紧 | 方向正确但实现偏重 / 可明显简化 | Minor：Scope 边界易被误读 |
| 23 | `616c942` | 依赖、XLSX 导出、OSS STS 加固 | 必要且克制 | 未发现本提交残余 |
| 24 | `b86d9a5` | 写平台能力真实，但单提交范围过大并改写历史迁移 | 方向正确但实现偏重 / 质量不足 | Important：迁移历史；Minor：标准测试复现残余 |
| 25 | `c3a04c3` | R2 写迁移基本完整，附件所有权当时遗漏 | 方向正确但实现偏重 / 后续已修复 | Important 已由 27 修复 |
| 26 | `154f6f4` | R3 保持 Scope A，但 migration/Worker 当时未接线、fence 粗 | 方向正确但实现偏重 / 后续已修复 / 可明显简化 | Important 接线已修；Minor fence 未修 |
| 27 | `fa2581c` | 代码集成闭环，生产切写/升级/回滚未闭环 | 方向正确但实现偏重 / 质量不足 / 可明显简化 | 3 Important + 2 Minor 最终残余（其中部分与上行同根因） |

## 最高信号发现

### Important 1：生产发布把所有业务波次一次性激活

`deploy/aliyun/deploy.sh:36-43` 调用 `scripts/set-writer-fences.mjs`，后者 `:2-19` 一次启用 31 个 writer/Worker resource。前置 `scripts/check-write-drain.mjs:4-15` 只数两个控制表状态，不做 canonical 业务对账，也没有按采购→实物→物流→财务的 UAT/签字序列。

这不是“Scope B 未实现”的指责，而是 Scope A 发布控制错误：源码可以迁移现有语义，但部署不能把依赖 Scope B 门禁的领域 writer 自动当作已批准波次。建议把激活从通用 deploy 中移出，改为显式 manifest/批准输入的逐 command 操作；未列入波次的 resource 保持 disabled。

### Important 2：回滚可绕过 R2/R3 领域事实

`deploy/aliyun/rollback.sh:49-62` 只在目标镜像没有 Worker 时运行安全检查；`scripts/check-legacy-rollback-safety.mjs:24-28` 又只统计平台命令。回滚到“已有 Worker、但 R2/R3 尚未退役旧 writer”的提交 24 时，会漏过已经产生的采购/库存/财务事实。

建议任何版本回滚都先读目标 release manifest 的 schema/writer compatibility；事实检测必须覆盖所有 canonical command 或使用 generation/owner 激活审计，而不是维护一份平台命令白名单。

### Important 3：历史迁移改写让既有环境无法走普通升级

提交 24 改写 `drizzle-mysql/0000_hot_firestar.sql` 与 `0001_thankful_slyde.sql`，最终 `scripts/check-mysql-migration-history.mjs:35-49` 又强校验 hash。对已应用父版本历史的数据库，preflight 必然停止。fail closed 是正确止损，但这证明 MIG-001 没有闭环。

建议恢复历史 migration 字节不变，把 `serial→int` 等变化放入新的追加迁移；对确有人工历史的环境提供版本化、可测试的 reconciliation migration，而非 README 人工选择。

## 已修复问题链

- 提交 25 的 import/source file 越权引用：提交 27 强制 `import_upload + current user` 实体绑定，并补负向测试。
- 提交 26 的 `r3.domain-event as never` 与孤立 migration：提交 27 统一为共享 `domain.event` Worker contract，并把 schema 接入 `0004` journal。
- 提交 19–21 分别关闭生产候选、供应商资料/绩效、退货读取的父阶段越权/授权饥饿风险；最终态保持修复。

## 与 `docs/refactor` 的偏差

- 规划要求用例级 `command_type + owner(legacy/v1/blocked) + epoch + 激活审计`；实现使用 `resource + owner + enabled + generation`，R2 大多逐命令，R3 多为领域/Route 粗粒度。
- 规划要求每个 canonical command 重复 `Block → Reconcile → Activate → Observe`；实现是通用 deploy 一次性 stop/drain/migrate/enable-all/start。
- 规划要求业务 owner 按 T2–T5 签 UAT，完整 oracle 零差异后批准；仓库没有对应签字/不可变 UAT artifact，只有代码测试。
- 规划明确 Stage 5 只建 Receipt contract、实物闭环随 Scope B 联合波次；实现未越界补业务，但提交/测试“complete Scope A”与自动全启用措辞容易把源码完成误导为切写完成。
- 规划要求不重写历史 migration；最终实现与此相反，README 只记录停止后的人工处置。

## 过度设计候选与保留/简化建议

### 应保留

- Fastify 独立 API、后端作用域授权、Origin/CSRF、事务 UoW、Step-up request binding、事务审计/Outbox、旧 writer 410。
- Worker 对邮件/SMS/扫描/普通通知的异步隔离；这些副作用确实不应占用交易请求进程。
- 真实 MySQL 锁/唯一约束/未知结果 fail-closed 测试框架。

### 应简化

- 合并 platform/R2/R3 三套 command executor，保留一个可注册 command policy 的执行器，统一 digest、idem、fence、response replay 与 unknown outcome。
- 把 `finance.command`、`returns.command`、`logistics.shipment.command` 按真实 action 拆成 canonical command；随后 fence 自然逐命令，而非领域粗开关。
- deploy 只部署兼容代码/迁移，不自动激活业务 writer；独立 `activate-writer` 命令要求单个 command、expected generation、对账 artifact hash、批准人/原因。
- Worker 保留一个通用 durable Outbox 核心；domain notification recipient resolution 可作为小型 handler registry，不必继续扩大中央 switch。
- 迁移阶段名 `r2/r3` 从长期模块路径移出，逐步收敛为稳定领域名；避免下一轮出现 R4/R5 层叠。

## 测试与证据总评

本审查实际结果：Contracts/API/Worker TypeScript 通过；API 非 MySQL单元/契约 230/230；部署边界 15/15；Worker 非集成 5/5，4 个 MySQL 用例因环境变量缺失跳过。标准 pnpm 测试入口在依赖状态检查阶段被初始基线遗留 `allowBuilds` 占位值拒绝。

测试对局部事务、权限和契约有较强证据，但对生产门禁存在“测试脚本形状而非业务事实”的倾向：例如它断言所有 fence 被激活，却没有验证逐波 UAT、canonical 对账或目标版本回滚兼容。最终状态应定性为“代码级 Scope A 写迁移基本完成，生产切写 No-Go 条件仍存在”。

## 段落结论

前三个读权限加固和依赖/OSS 加固是必要且克制的高质量修复；写迁移的技术方向正确，也真实建立了独立 API、事务安全、Step-up、Outbox/Worker 和旧入口退役。然而提交 24–27 在极短提交链中引入约 1.3 万行非生成实现、5 千行测试与多套控制面，且最终发布/回滚脚本没有满足其自身规划的逐命令切写与兼容证明。

因此本段总体标签为：**方向正确但实现偏重**、**可明显简化**、**质量不足**。保留安全与事务内核，暂停把 `fa2581c` 直接作为生产切写候选；先修复历史迁移、逐波激活和全 canonical 回滚安全，再补真实 MySQL/UAT artifact。
