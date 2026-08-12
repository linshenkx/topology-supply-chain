# 007 · 登录锁定计数原子化

## 提交元数据与父链

- 提交：`5fa8021973a04f6af54d6a3761a0d659d9c37a57`（`fix: make login lockout counters atomic`）
- 父提交：`23c4572d2a0662f94f575674db0b86a35453d137`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T04:16:31+08:00`
- 命令证据：`git show 5fa8021`；最终链：`git log --oneline 5fa8021..fa2581c -- app/api/auth/login/route.ts`

## 声明目标

防止并发错误密码丢失计数，防止正确密码清零覆盖并发第五次失败，并在创建 Session/challenge 前复核账号 active。

## 实际改动和 diff 规模

2 文件，`138 insertions / 18 deletions`：登录路由净增 57 行，新增 63 行测试。

## 对应 docs/refactor 依据

Gate B 要求登录锁定策略有效且可审计（`docs/refactor/04-production-gates.md:116-139`）；阶段 1 要真实 MySQL 登录路径通过并发/重放负测（`docs/refactor/03-migration-roadmap.md:141`）。

## 必要性与 Scope 分类

认证并发属于 Scope A 基础安全。无 Scope B 业务变化。

## 复杂度增量

在单一路由增加两段事务/CAS 和两次 active 复核；复用既有 transaction/affected-row helper，无新依赖或组件。

## 正确性、安全、权限、事务、兼容

错误计数由数据库 `failed_attempts + 1` 且 `<5` 封顶；锁 credential 与 user 位于同一事务。成功清零带旧计数、旧 updatedAt、未锁和 `<5` 条件，能拒绝与第五次错误竞争的成功登录。响应仍沿用原协议。

## 业务语义是否改变

仅让账号锁定在并发下符合既定“五次失败”规则；正常登录语义不变。

## 测试与证据质量

4 个测试详细断言 SQL/CAS 与代码顺序，但全是源码模式测试，没有用两条 MySQL 连接制造“成功密码与第五次失败”竞争。

## 当时问题

- **Minor — 证据不能独立证明真实隔离级别下的竞态结果。** `5fa8021:tests/login-password-attempts.test.mjs:1-63` 只匹配源码；阶段笔记的真实 MySQL 双连接测试针对付款，不是登录。实现推理成立，但门禁级证据仍缺数据库并发 oracle。

## 后续修复链

`b86d9a5` 将登录写迁到 Fastify 命令平台；最终 `apps/api/src/modules/auth/writes.ts:418-439` 保留原子失败计数/清零，并由更完整的 auth write 与 MySQL platform 集成测试覆盖；旧 Next 登录入口 410。

## 最终状态

旧实现退役，核心并发规则在新 IAM writer 中保留；提交级证据缺口由后续平台集成测试部分补足。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**
- 置信度：中高；代码推理高，提交当时的运行证据中等。
