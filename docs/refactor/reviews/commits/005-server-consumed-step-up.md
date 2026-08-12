# 005 · 服务端消费 Step-up proof

## 提交元数据与父链

- 提交：`3533a769bde67c342efe5d89f5aee217c3814f5d`（`fix: require server-consumed step-up proofs`）
- 父提交：`a9791b581aa9328e67a24490f3c81fe8efaeeedc`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T04:03:24+08:00`
- 命令证据：`git show --stat 3533a76`、`git show 3533a76:app/lib/step-up.ts`

## 声明目标

移除客户端 `smsVerified` 授权含义；Step-up challenge 由服务端验证并一次性消费；登录/Step-up OTP 使用 CAS；审批 proof 与审批抢占置于事务。

## 实际改动和 diff 规模

14 文件，`546 insertions / 87 deletions`。横跨认证、审批、财务、两个前端、两个 DB 兼容 helper 和 234 行测试，是前 8 个提交中首个宽切片。

## 对应 docs/refactor 依据

SEC-002 完成标准要求跨用户、跨会话、跨动作、跨对象、过期和重放全部失败（`docs/refactor/04-production-gates.md:40-43`）；业务基线进一步要求绑定 session、对象版本和 canonical request hash（`docs/refactor/01-business-baseline.md:285-289`）。

## 必要性与 Scope 分类

关闭可直接绕过付款/审批复核的 P0 是 Scope A 必需；没有实现 Purchase Receipt、BOM 或质检业务，未越入 Scope B。

## 复杂度增量

新增 `step-up-policy`、`step-up`、跨方言 upsert/affected-row 适配，前后端调用契约改为 challengeNo。复杂度主要来自同时兼容 D1 与 MySQL 以及在旧大路由中打补丁。

## 正确性、安全、权限、事务、兼容

proof 至少绑定 user、purpose、action/entity scope、verifiedAt/expiry，并由业务事务 delete 消费；OTP CAS 和错误计数也改为原子条件。前端从布尔值迁到 challengeNo，属于必要契约变化。

## 业务语义是否改变

高风险操作必须先完成真实服务端复核；付款/审批业务效果本身未设计性改变。

## 测试与证据质量

11 个主要单元/源码测试覆盖 scope、preview、消费条件、跨方言 affected rows、移除布尔值、审批 CAS、OTP salted hash；证据广但仍以源码结构测试为主，未覆盖“同对象改金额/流水后重放 proof”的真实负例。

## 当时问题

- **Critical — proof 未绑定 session、对象版本和完整交易意图。** `3533a76:app/lib/step-up.ts:14-54` 的消费输入只有 user/localPreview/scope/time；`3533a76:app/lib/step-up-policy.ts:5-12` 的 scope 仅为 action + 数字 ID。攻击者或误操作可在验证码后改变金额、银行流水、日期等关键 payload，或在同用户另一 Session 使用 proof，只要先消费者仍命中相同对象。这关闭了客户端布尔绕过，却未达到 SEC-002 的完整完成标准。
- **Important — 普通审批仍先提交 claim，再在事务外执行跨域副作用。** `3533a76:app/api/approvals/route.ts:66-100` 对非 financial correction 先 `withDbTransaction(db, claimApproval)`，随后直接更新领域表；后续失败会留下“审批已完成、业务未完成”。提交笔记也明确承认此取舍（`docs/refactor/stage1-implementation-notes.md:31`）。

## 后续修复链

`7c85457` 先把财务行锁纳入审批更正；`b86d9a5` 增加 sessionId、action、objectType/id/version、requestDigest 绑定（最终旧 helper 证据：`app/lib/step-up.ts:20-84`），并建立 Fastify 命令事务/审计/Outbox；`154f6f4` 迁移审批与财务写，旧入口退役。

## 最终状态

两个高信号问题均在最终基线关闭：Fastify Step-up challenge 写入 `session_id/object_version/request_digest`（`apps/api/src/modules/auth/writes.ts:710-711`），领域命令在同一 UoW 内执行 effect、审计和幂等完成标记（`apps/api/src/platform/commands.ts:194-256`）。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**
- 置信度：高。
