# 024 · `b86d9a5` Fastify 写平台底座审查

## 提交元数据与父链

- 完整 SHA：`b86d9a52529c9e155546c5c73d0a34d861b5521b`
- 主题：`feat: add Fastify write platform foundation`
- 作者/时间：linshen，2026-08-12 02:03:33 +08:00
- 父提交：`616c942b681053334b11a5338cb30d4ed699280c`
- 后继链：`c3a04c3` → `154f6f4` → `fa2581c`。

## 声明目标

交付 T1：Fastify 写事务、canonical 幂等、writer fence、Step-up、审批 effect registry、事务 Outbox、独立 Worker、文件扫描状态机、平台/IAM 写迁移和生产部署边界。

## 实际改动和 diff 规模

- 108 文件，`+31,623/-1,635`。其中两份约 11,917 行迁移快照占大头；仍有数千行平台/API/Worker/测试实现。
- 新增 Worker 镜像与 596 行 Worker、847 行 auth writes、304 行 command executor、平台安全/注册/Outbox、4 张控制面表/字段迁移及生产脚本。
- 旧平台写端点退役为 410，前端改走 v1 mutation seam。

## 对应 `docs/refactor` 依据

- `stage5-write-migration-plan.md` T1、标准事务模板及 Worker/Step-up/File/Approval 要求。
- `02-target-architecture.md` 第 9 节、`04-production-gates.md` MIG-002/SEC-002/AUTHZ-001。

## 必要性与 Scope 分类

事务、服务端授权、Step-up、幂等与退役旧写端点属于 Scope A 必要能力。一次同时落地 Worker、Outbox、文件扫描、审批内核和全生产发布/回滚框架，明显扩大审查爆炸半径，属于“方向正确但实现偏重”。

## 复杂度增量

- 新运行组件：独立 Worker 与健康端口。
- 新持久化概念：`command_idempotency`、`writer_fences`、`outbox_messages`、`resource_versions`，以及 Step-up/file 扩展字段。
- 新安全概念：Origin/CSRF、request digest、session-bound Step-up、OTP sealing。
- 新发布概念：generation 2 fence、drain、migration-history preflight、三镜像协同回滚。
- 单提交 108 文件使原子审查、回滚定位和 blame 成本过高，适合拆成控制面、IAM、文件/Worker、部署四个可独立门禁提交。

## 正确性、安全、权限、事务、兼容

- 正面：`apps/api/src/platform/commands.ts` 将 fence、幂等记录、业务写、审计/Outbox置于同一事务；未知 commit outcome fail closed。
- Step-up 不再信任客户端布尔值，绑定 session/action/object/version/request digest。
- 旧写端点 410，减少双写面。
- 兼容风险：重写历史迁移 `0000/0001`，与文档“历史迁移不可改写”冲突，见下述问题。

## 业务语义是否改变

平台/IAM 写行为切到 v1，并把通知、邮件、扫描改为异步 Worker；业务领域写尚未在此提交迁移。异步化会改变通知送达时间，但交易事实仍同步提交，方向正确。

## 测试与证据质量

- 有真实 MySQL 原子/未知结果/Worker replay 测试文件，但本审查环境没有 `MYSQL_WRITE_TEST_URL`，Worker 4 个集成用例跳过。
- 最终 API 纯测试 230/230、Worker 5/5 非集成、类型检查通过。
- 代码测试能证明执行器局部语义；不能证明真实生产 schema 历史、分波切写和业务 UAT。

## 当时问题

- **Important — 改写既有 MySQL 历史迁移，导致非空环境升级与自身 preflight 冲突。** 此提交对 `drizzle-mysql/0000_hot_firestar.sql` 做约 `+104/-104`、对 `0001` 做 `+2/-2`，同时新增 `scripts/check-mysql-migration-history.mjs`，后者按本地文件 SHA 严格匹配已应用 hash（最终 `:35-49`）。任何已经应用父提交 0000/0001 的环境都会因 hash 变化停止，无法走普通追加升级。最终文档承认需人工“受控路径”，故问题仍存在。
- **Minor — 标准测试入口可复现性未闭环。** `pnpm-workspace.yaml:1-2` 的 `@alicloud/openapi-core: set this to true or false` 是初始基线遗留，但此大提交宣称生产底座完成却未修；本审查 `pnpm --filter @topology/api test` 在 install 状态检查阶段 fail closed。非本提交引入，归为残余门禁而非回归。

## 后续修复链

- 提交 27 把 R2/R3 migration 接入正式 `0004` journal、接通通用 domain-event Worker、修复 import file binding；这些是本底座集成的后续补全。
- 历史 0000/0001 改写没有后续恢复为追加迁移，最终仍存在。

## 最终状态

写平台局部能力真实存在且测试密度高；但生产迁移历史门禁并未闭合，不能仅凭“fresh MySQL 通过”认定已有环境可升级。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**质量不足**。
- 置信度：高。
