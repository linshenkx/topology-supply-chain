# 段落 01 · 基础、安全与独立 API runtime（提交 001–009）

## 审查范围与方法

连续审查 `2523b409` 至 `8f57eac` 九个提交；固定最终基线 `fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`。每个提交同时核对父提交、自身 diff、最终对应实现与其后修复提交。规划文字仅作为声明，问题判定以 Git/路径/行号或命令证据为准。

## 提交统计与结论分布

| 序号 | 主题 | 净规模 | 结论标签 |
| --- | --- | ---: | --- |
| 001 | 重构蓝图 | +1906 | 方向正确但实现偏重 |
| 002 | 身份边界 | +145 | 必要且克制 |
| 003 | 调拨原子化 | +165 | 必要且克制；后续已修复 |
| 004 | 登录 MFA 边界 | +50 | 必要且克制；后续已修复 |
| 005 | Step-up proof | +459 | 方向正确但实现偏重；后续已修复 |
| 006 | 阿里云构建边界 | +94 | 必要且克制 |
| 007 | 登录锁定计数 | +120 | 必要且克制；后续已修复 |
| 008 | 财务账本串行化 | +936 | 方向正确但实现偏重；后续已修复 |
| 009 | 独立 API runtime | +1629 | 方向正确但实现偏重 |

累计命令证据：`git diff --shortstat 2523b409^ 8f57eac` 返回 `59 files changed, 5743 insertions(+), 239 deletions(-)`。

## 净复杂度趋势

复杂度呈两次阶跃而非线性增长：提交 001 一次建立 1906 行蓝图和大量横切概念；002–007 多为窄 P0 修复；008 为跨多个财务写者的锁/账本规则与真实 MySQL 证据；009 再引入 workspace、Fastify 进程、contracts、OpenAPI 和安全日志。净增代码高，但测试占比也高，不能把行数直接等同过度设计。

运行组件从单一 Next 全栈增为“Next + 尚未接流量的 Fastify runtime”；这是前后端分离的必要暂态。真正双栈风险出现在后续接路由/迁业务时，因此 009 本身没有 writer 冲突；最终通过 writer fence、幂等和旧入口 410 收口。

## 问题统计

共记录 10 项：**Critical 1、Important 5、Minor 4**。

- 后续/最终确认关闭 6 项：调拨审计事务外、登录 OTP 非 CAS、Step-up 缺完整绑定、普通审批副作用事务外、登录并发证据/旧实现、财务旧双栈锁耦合。
- 生产边界接受 1 项：旧本地预览 helper 仍是隐式 opt-in，但阿里云固定环境标记且 Fastify 预览边界更严，不构成最终生产缺陷。
- 仍保留 3 个文档/设计候选：阶段 2 蓝图打包过多能力、一个文档证据路径简写、安全日志控制器偏重。它们是维护/执行风险，不是当前业务正确性缺陷。

最高信号发现是提交 005 的 proof 只绑定 user + action/entity scope，未绑定 session、对象版本和完整 request digest（`3533a76:app/lib/step-up.ts:14-54`）；这意味着“移除客户端布尔值”当时仍不足以关闭付款 Step-up P0。最终 Fastify challenge 已持久化 `session_id/object_version/request_digest`（`apps/api/src/modules/auth/writes.ts:710-711`），应明确归为“当时引入/遗留，后续已修复”，不能报告成当前缺陷。

## 与 docs/refactor 的偏差

- 规划正确区分 Scope A 与 Scope B：路线图明确阶段 1 不提前完成生产/质检/库存闭环，阶段 6 才关闭 BIZ-001/002/003（`docs/refactor/03-migration-roadmap.md:116-142`、`docs/refactor/04-production-gates.md:24-31`）。因此 Purchase Receipt、BOM 实物预留/领料/消耗、质检放行/隔离未在 001–009 完成，不判 Scope A 失败。
- 提交 005 的阶段笔记称 proof 绑定“动作与具体业务 ID”，表述本身准确，但若据此宣布 SEC-002 完整关闭会误导；完整门禁还要求 session/version/request hash。
- 提交 009 没有一次完成阶段 2 的 Worker、DB、fence、Trace 等出口，但其切片笔记明确列为未完成，属于有界交付而非文档违约。
- 蓝图存在一处 `commit/route.ts` 简写，证据可复核性小幅下降。

## 初始蓝图是否诱发过度设计

有诱发风险，但没有走向微服务/多库/MQ 式失控。风险集中在阶段 2 一次罗列 API、Worker、多个 packages、UoW、Outbox、fence、IAM、审批内核、全可观测和全 CI；若把它当单一前置里程碑，会形成平台先行。实际历史用 009 的最小空载 API、后续首个真实读域、再到写平台逐步展开，证明“垂直切片 + 到用时建能力”更合适。

## 基础安全修复的最小性与兼容性

002、004、006、007 基本最小且保持现有 Session/前端协议；003 用小 helper 和 CAS 修复调拨；005/008 因旧大路由和双方言兼容而明显变重，但属于等待重构前不能推迟的资金/权限止血。兼容策略总体保守：生产 fail closed，本地 preview 无真实副作用，旧 Web 正常路径保留。

## Fastify/API runtime 必要性与双栈判断

必要。仅重排 Next Route 无法形成独立构建/启动/发布和契约边界。009 的 health/errors/contracts/requestId/关闭路径是可独立运行的最小骨架，后续被真实读写模块持续复用。双栈复杂度确实增加，但本提交尚未接入业务流量；最终基线通过 `apps/api/src/server.ts` 的 production manifests、`apps/api/src/platform/commands.ts:131-256` 的 fence/幂等事务，以及 legacy 410 完成所有权收口。应保留独立 runtime，简化其外围抽象，而不是退回 Next 单体。

## 保留与简化建议

- 保留：生产身份头双层清理、DB CAS/行锁、真实 MySQL 并发 oracle、完整 Step-up binding、独立 Fastify runtime、共享 contract、writer fence/幂等/事务审计。
- 简化：把蓝图阶段 2 改成按首个可验证 vertical slice 拉取能力；没有消费者前不创建模块空壳。
- 简化：评估用固定 logger factory、标准 serializers/redact 和少量 hooks 替代 285 行 `LogController` 覆写；先写等价泄密负测，再删代码。
- 维护：文档证据一律写仓库根相对完整路径；任何“已关闭”门禁必须附运行态或数据库 oracle，不只附源码正则测试。

## 段落结论

九个提交总体完成了可信的 Scope A 起步：先形成边界，再关闭身份、OTP、调拨和付款高风险，最后建立独立 API runtime。质量不是均匀的——005 在当时仍留下 Critical proof binding 缺口，003/004 也需要后续原子性修复；但这些均能沿 Git 链确认关闭。最终判断：方向正确、关键安全修复大多必要且克制；主要改进空间在蓝图和 runtime 横切设施的减法，而不是撤销前后端分离。
