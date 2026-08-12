# 004 · 登录 MFA 生产边界

## 提交元数据与父链

- 提交：`a9791b581aa9328e67a24490f3c81fe8efaeeedc`（`fix: enforce login mfa production boundaries`）
- 父提交：`9b25fe8d3ceb592c3da5475e72c9de13485c37c0`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T03:26:38+08:00`
- 命令证据：`git show a9791b5`；修复对照：`git diff a9791b5 3533a76 -- app/api/auth/verify/route.ts`

## 声明目标

复用生产预览边界，按数据库可比较时间过滤可信设备与 login challenge，并限制 challenge purpose。

## 实际改动和 diff 规模

4 文件，`56 insertions / 6 deletions`：登录 +11/-3、验证 +9/-3、测试 +33、笔记 +3。

## 对应 docs/refactor 依据

身份边界和 Session/MFA 属于 Scope A；门禁要求真实 MySQL 登录、伪造身份和重放测试（`docs/refactor/03-migration-roadmap.md:141`）。

## 必要性与 Scope 分类

这是生产认证兼容与时区/用途约束的必要修复，属于 Scope A，不涉及业务闭环。

## 复杂度增量

仅增加查询谓词并复用已有 helper；无依赖、Schema、概念或运行组件增加。

## 正确性、安全、权限、事务、兼容

可信设备过期和 challenge 过期改为 ISO 文本在 DB 查询中比较，避免 Node 对无时区文本的解析差异；login verify 只消费 `purpose=login`。正常 MFA 响应契约不变。

## 业务语义是否改变

过期可信设备不再绕过短信；非 login challenge 不再可被登录 verify 使用。无业务领域语义变化。

## 测试与证据质量

3 个测试均为源码模式断言，覆盖共享边界、DB 时间过滤和 purpose/expiry 条件；缺少并发双请求和真实 MySQL 行为证据。

## 当时问题

- **Important — 成功验证码仍不是原子消费，可并发创建多份会话。** `a9791b5:app/api/auth/verify/route.ts:12-26` 先读取 `verifiedAt IS NULL`，校验后用仅按 ID 的 update 标记，再 upsert 可信设备并建 Session；两个并发请求可同时通过初读。错误次数也使用 `challenge.attempts + 1` 的读改写。该问题不否定本提交的 purpose/expiry 修复，但未满足重放门禁。

## 后续修复链

紧随其后的 `3533a76` 用 `verifiedAt IS NULL + expiry + attempts` 条件 CAS 并检查 affected rows，错误次数改数据库原子递增；`b86d9a5` 再把登录/verify 迁到 Fastify 命令事务和幂等边界，旧入口 410。

## 最终状态

并发消费缺陷已修复；最终旧登录路由退役（`app/api/auth/login/route.ts:1-4`），Fastify 登录写路径继续使用行锁/条件更新与幂等命令。

## 结论与置信度

- 标签：**必要且克制**、**后续已修复**
- 置信度：高。
