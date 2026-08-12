# 提交 011：认证与主数据读迁移

## 提交元数据与父链

- SHA：`6b0d6ce6007d6459a310ebfc2134d7960c49299e`
- 父提交：`988416fe98a9b53d8a6e19a7d4430bdd9358fadb`
- 主题：`feat: migrate authenticated master data reads to api`
- 作者/提交时间：linshen，2026-08-11 12:27:37 +08:00。
- 父链：010 → 011；最终基线 `fa2581c`。

## 声明目标

为 Fastify 建立 MySQL 连接边界、复用 legacy Session Cookie，迁移 `/api/v1/session` 与首个低风险 `/api/v1/master-data` GET，并让前端主数据读取走 v1。

## 实际改动和 diff 规模

24 文件、4,149 行新增、18 行删除。新增 748 行数据库适配、421 行认证、422 行主数据模块、239/73 行契约和约 1,775 行测试；同时新增一个专用 Next 开发代理并给 API 容器注入最小数据库配置。

## 对应 docs/refactor 依据

- `02-target-architecture.md:219-289`：契约、Session、RBAC+scope。
- `03-migration-roadmap.md:186-210`：Stage 3 IAM 与低风险只读查询。
- `04-production-gates.md:116-138,169-191`：权限、负向测试、可复现证据。
- `stage3-auth-read-implementation-notes.md` 的 PASS 结论按待验证声明处理。

## 必要性与 Scope 分类

属于 Scope A。认证上下文、MySQL 类型边界和第一个真实读端点是独立 API 从“骨架”变为可验证后端的必要增量。

## 复杂度增量

- 文件 24，净增 4,131 行；新增运行依赖 `mysql2`。
- 概念：数据库 deadline/unknown outcome、Session 心跳、角色有效期、本地 preview、父子集合闭合、运行时 JSON Schema。
- 运行组件未增加，但 API 从无状态健康服务变为依赖 MySQL。
- 748 行数据库适配对一个读迁移偏重，但它替代了 D1 强转并提供超时/销毁语义，主要是可复用底座而非复制业务复杂度。

## 正确性、安全、权限、事务、兼容

- Cookie 优先于 preview，畸形/未知 Cookie 不降级；生产缺数据库 fail closed。证据：`git show 6b0d6ce:apps/api/src/modules/auth/index.ts` 第 326-349 行。
- 工厂 scope 要求有效 `factoryId`，只读 active SKU 与 approved+active BOM；拒绝未授权角色。证据：同提交 `master-data/index.ts` 第 239-248、327-348 行。
- 读请求仍更新 `last_seen_at`，因而不是纯读；代码用条件更新和复核处理撤销竞态，但在线 shadow 会产生副作用。这一限制后来被 Stage 5 计划明确记录。
- 契约使用共享 JSON Schema，但前端仍直接 `fetch` 并手写解析，不符合目标架构“OpenAPI 生成 Client”完成态。

## 业务语义是否改变

有意收紧：finance 不再读取完整主数据，factory 只见 active/approved 子集；过期角色不在 GET 中写回 expired。属于授权和副作用纠正，需要业务 UAT，但没有引入新业务能力。

## 测试与证据质量

测试覆盖 Cookie/preview 反例、角色矩阵、数据库排队与执行超时、集合闭合、稳定排序、开发代理和真实 MySQL/TLS 本地验证。命令：`pnpm --filter @topology/api test`、`pnpm --filter @topology/api build`。质量较高；RDS 查询计划、时区与业务角色签字未完成，不能把本地 MySQL 当生产证据。

## 当时问题

- Important：契约边界只做到 JSON Schema/OpenAPI 事实源，前端仍手写 `fetch("/api/v1/master-data")`，没有生成 Client 或 drift 门禁。证据：`git show 6b0d6ce:app/components/MasterDataWorkspace.tsx` 第 18 行；`rg -n 'openapi-generator|orval|generate.*client' package.json apps packages` 无生成器命中。此问题最终仍存在。
- Minor：主数据采用 500/1000/2000 有界全量快照，规模溢出返回 503 而非分页；正确性优先但兼容和可用性需 UAT。证据：`master-data/index.ts` 第 22-25、263、289-320 行。

## 后续修复链

018 将专用 `app/api/v1/master-data` 代理收敛到共享开发桥，并统一注册全部读模块；后续写迁移复用数据库/认证底座。未见生成 Client 的后续修复。

## 最终状态

数据库、Session 和主数据授权底座保留并扩展；生成 Client 缺口仍在。分页风险仍以固定上限/失败关闭方式存在。

## 结论与置信度

- 标签：**方向正确但实现偏重**。
- 置信度：高。
