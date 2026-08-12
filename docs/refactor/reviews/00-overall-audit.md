# Scope A 重构逐提交总审查

## 1. 审查结论

本轮只审查，不修改实现。审查范围为初始交付基线 `607cb1c` 之后、最终集成 `fa2581c` 之前的全部 27 个提交，并逐项对照 `docs/refactor` 的目标、路线、门禁和开放决策。

主审结论如下：

1. **前后端分离只完成了主要运行链路，没有完成唯一后端边界。** Web、Fastify API、Worker 已能独立构建和部署，当前前端主要调用 `/api/v1`；37 个旧写方法均已退役。但 Next 仍保留 18 个可由旧 `/api/*` 直接访问的业务 GET，实现中仍有已在 v1 修复的越权逻辑，因此不能宣称读侧已完成安全切换。
2. **基础安全修复总体有效且大多应保留。** 身份 Header 旁路、登录/OTP 并发、客户端伪造 Step-up、付款并发超额、CSRF/Origin、幂等、事务审计/Outbox、文件隔离等均得到实质加固；多个早期缺陷可沿后续提交确认关闭。
3. **项目没有因本轮重构变得更简单。** `607cb1c..fa2581c` 共改动 268 个文件，新增 83,380 行、删除 2,946 行；扣除迁移快照/锁后，运行源码仍净增约 26,400 行，测试净增 14,617 行。独立 API 与安全测试解释了部分增长，但双读栈、三套命令执行层、R2/R3 阶段命名和重复 DTO/mapper 说明“项目规范化”尚未完成。
4. **没有大范围越过 Scope A 去补业务。** Purchase Receipt、BOM 真实批次预留/领料/消耗、质检放行/隔离仍明确留在 Scope B。本轮主要改变技术所有权和安全不变量，而非补完整业务状态机。
5. **当前不能作为生产切写候选。** 旧 GET 可绕过 v1 授权、历史 migration 被改写、发布脚本一次激活全部 writer、回滚检查漏算 R2/R3 事实，这四项必须先关闭。

综合评价：**方向正确，安全价值真实，但实现明显偏重，切换与规范化收口不足。** 不建议推倒重写，也不建议立即进入 Scope B；应先进行一轮严格限定为 Scope A 的减法和生产门禁修复。

## 2. 审查口径

- 规划文档只作为待验证声明，不把“文档写了”视为实现证据。
- 每个提交同时核对父提交、自身 diff、后续修复链和最终 `fa2581c` 实现。
- 明确区分“提交当时存在”“后续已修复”“最终仍存在”。
- Scope B 未实现不计为 Scope A 缺陷；只有实现或文档把它错误包装成已完成时才记偏差。
- 复杂度不只看行数，还看运行组件、概念数、重复实现、长期命名和删除旧结构的程度。

## 3. 当前完成度裁决

| 目标 | 裁决 | 说明 |
| --- | --- | --- |
| 独立后端运行时 | 已完成 | Fastify API、MySQL runtime、独立镜像和同域 Nginx 边界已建立。 |
| 前端切到新 API | 基本完成 | 活跃页面主要调用 `/api/v1`，但仍是手写 `fetch`/mutation seam。 |
| 写入口唯一所有者 | 代码层完成 | 30 个 POST、6 个 PATCH、1 个 DELETE 旧方法均进入 `retiredPlatformRoute`。 |
| 读入口唯一所有者 | 未完成 | Next 仍有 21 个非退役 GET；扣除 2 个开发 v1 桥和健康检查，仍有 18 个旧业务 GET。 |
| 基础认证与会话安全 | 基本完成 | 生产 Header 旁路关闭，会话、OTP、CSRF/Origin 和本地 preview 边界明显增强。 |
| 高风险 Step-up | 基本完成 | 最终绑定 session、动作、对象、对象版本和 request digest，并在事务内一次性消费。 |
| 事务、幂等、并发 | 核心能力完成 | 写平台提供 UoW、幂等、fence、审计/Outbox；仍缺完整生产切写和回滚证明。 |
| 项目结构规范化 | 未完成 | 长期源码仍使用 R2/R3 阶段命名，存在三套 executor、重复 DTO/mapper、旧 API 业务实现。 |
| 契约事实源 | 部分完成 | JSON Schema/OpenAPI 存在，但未按目标架构生成前端 Client。 |
| 可重复生产升级 | 未完成 | 既有 migration 被改写，历史 hash preflight 会阻断普通追加升级。 |
| Scope B 业务补全 | 未实施 | 符合本阶段边界，不计为缺陷。 |

## 4. 当前生产阻断

### 4.1 旧 GET 绕过 v1 授权加固

Nginx 只把 `/api/v1/*` 转发给 Fastify，其他 `/api/*` 仍进入 Next（`deploy/aliyun/nginx-scm.conf:31-63`）。最终代码仍有 18 个旧业务 GET，并不是 410 或 v1 兼容代理。

这不是单纯的代码清理问题，而是当前授权绕过。例如：

- `app/api/quality-inspections/route.ts:21-42` 对任何 `supplier_qc` 返回全局最近 200 条质检记录；v1 已改为 supplier/factory 角色绑定作用域。
- `app/api/production-orders/route.ts:16-50` 对 `factory` 角色但缺失/异常 `factoryId` 的账号会走全量生产单和全量选项；v1 已 fail closed。
- 多个旧 GET 仍在全局 `LIMIT` 后做外部范围过滤，可能既扩大读取范围又造成授权数据饥饿。

因此，提交 19–21 对 v1 的授权加固并未形成完整生产安全边界。应先审计旧路径调用量，再将外部旧 GET 统一 410 或变成只调用 v1 的安全兼容层；不能继续保留两套独立查询实现。

### 4.2 历史 migration 被改写

提交 24 修改了既有 `drizzle-mysql/0000_hot_firestar.sql` 和 `0001_thankful_slyde.sql`，最终 `scripts/check-mysql-migration-history.mjs:35-49` 又要求已应用 hash 与本地文件一致。任何已经应用旧版本 migration 的数据库都会被 fail closed，无法走普通追加升级。

Fail closed 是正确止损，但不是升级闭环。历史 migration 应恢复字节不变，结构差异通过新的追加 migration 或有版本的 reconciliation migration 处理。

### 4.3 发布脚本一次激活全部 writer

`deploy/aliyun/deploy.sh:36-43` 在迁移后直接执行 `scripts/set-writer-fences.mjs`；后者一次启用 31 个 writer/Worker resource（`scripts/set-writer-fences.mjs:2-19`）。这与文档要求的逐 command、逐业务波次 `Block → Drain → Reconcile → Activate → Observe` 不一致。

当前 drain 只检查控制表的处理中状态，没有采购、库存、物流、财务的 canonical 对账，也没有业务 Owner 的 UAT/批准证据。部署代码可以保持安装态，但业务 writer 激活必须从通用 deploy 中拆出，并以单 command/单波次的对账证据为输入。

### 4.4 回滚检查漏算领域事实

`deploy/aliyun/rollback.sh:49-62` 在目标镜像带 Worker 时完全跳过 legacy rollback safety；`scripts/check-legacy-rollback-safety.mjs:24-28` 又只统计平台/IAM 命令，漏掉 R2/R3 的采购、库存、生产、物流和财务事实。

因此，产生新领域事实后仍可能回到“有 Worker、但旧业务 writer 尚未退役”的版本。回滚必须读取目标 release 的 schema/writer compatibility，并覆盖所有 canonical command；否则首次新写后只能 forward-fix。

## 5. 条件性安全与契约风险

以下问题是否升级为生产阻断取决于业务组织模型，但在决策关闭前不能声称权限模型完成：

- receiver 仍通过可变组织名称和发货目的地文本授权，并在全局 `LIMIT` 后过滤（`apps/api/src/modules/shipments/index.ts:150-188`）。
- 财务与审批读只做内部角色白名单，没有 Legal Entity scope（`apps/api/src/modules/finance/index.ts:391-460`）。如果系统永远是单公司，可作为显式限制；如果存在多法律主体，则是越权风险。
- 目标架构要求 Schema/OpenAPI 生成前端 TypeScript Client（`docs/refactor/02-target-architecture.md:221-225`），最终前端仍手写 URL、request/response 类型和解析逻辑，缺少 drift gate。

## 6. 复杂度与过度设计裁决

### 6.1 应保留的复杂度

以下新增不是无意义“架构秀”，而是本系统资金、库存、文件和多角色场景的生产必要成本：

- 独立 Fastify API、同域反向代理和独立构建/健康边界。
- 服务端 Session/RBAC/data scope、CSRF/Origin、完整 Step-up binding。
- MySQL 事务、行锁/CAS、幂等、unknown outcome fail closed。
- 事务内审计/Outbox，以及把短信、邮件、扫描等副作用移出交易请求。
- scope-before-LIMIT、最小 DTO、负向权限测试和真实 MySQL 并发 oracle。

### 6.2 明确偏重或未收敛的复杂度

- `platform/commands.ts`、`r2-master-procurement/command.ts`、`r3/command.ts` 形成三套命令执行层，重复处理 digest、幂等、fence、response replay 和事务上下文。
- `r2-*`、`r3/*`、`R2_COMMANDS`、`R3_COMMANDS` 把迁移阶段编号固化到长期模块、契约、资源和前端文件名中，不是稳定领域语言。
- R3 将多个真实 action 压进 `finance.command`、`returns.command`、`shipment.command` 等粗命令/fence；控制面概念很多，但隔离能力反而不足。
- API 读模块大量重复 row decoder、bounded query、mapper、错误映射和手写 SQL 字段块；最大的 suppliers 模块超过 1,800 行。
- 自定义安全日志控制器、注册 manifest、Worker 中央 switch 和部署脚本均有继续扩张趋势，需以等价负向测试为保护做减法。
- 旧 Next GET 业务实现没有删除，导致新旧读模型长期双重维护。

结论不是删除 Worker/Outbox/fence，而是**保留安全内核，合并重复执行层，去掉阶段性命名和双实现**。

## 7. 与 `docs/refactor` 的主要偏差

| 文档声明 | 最终实现 | 裁决 |
| --- | --- | --- |
| 前端只使用生成或封装的 TypeScript Client | 只有局部 mutation seam，GET 和很多 DTO 仍手写 | 未完成 |
| 授权过滤应进入 SQL 且在 LIMIT 前 | v1 多数已做到，但旧 GET 仍可绕过；shipment 仍在 LIMIT 后过滤 | 未完成 |
| 每个 canonical command 分波切写并对账/UAT | deploy 一次激活全部 31 个资源 | 明确偏离 |
| migration 历史不可改写 | 0000/0001 被改写 | 明确偏离 |
| checkpoint/门禁需完整证据 | 018 后连续出现三项授权加固 | 018 只能叫集成点，不能叫关闭点 |
| 生产/质检/库存必须联合业务波次 | 实现没有补 Scope B，但部署会一次激活对应 writer | 源码边界正确，发布表述和控制错误 |
| UAT/批准/恢复证据可复现 | 主要为代码测试，缺正式业务签字和完整 MySQL/恢复证据 | 未完成 |

## 8. 逐提交结论索引

### 001–009：蓝图、P0 安全与独立 API

- [001 重构蓝图](./commits/001-production-refactor-blueprint.md)：方向正确但偏重，平台能力打包过多。
- [002 身份边界](./commits/002-production-identity-boundary.md)：必要且克制。
- [003 调拨原子化](./commits/003-atomic-inventory-transfers.md)：必要；审计事务问题后续修复。
- [004 登录 MFA](./commits/004-login-mfa-boundaries.md)：必要；并发 CAS 后续补齐。
- [005 Step-up proof](./commits/005-server-consumed-step-up.md)：方向正确；早期 binding 不完整，最终已修。
- [006 阿里云构建](./commits/006-aliyun-production-build-boundary.md)：必要且克制。
- [007 登录锁定计数](./commits/007-atomic-login-lockout.md)：必要；后续补齐原子性。
- [008 财务账本串行化](./commits/008-serialized-financial-ledger.md)：必要但偏重；后续收敛。
- [009 独立 API runtime](./commits/009-independent-api-runtime.md)：必要，横切日志实现有减法空间。
- [分段总结](./segments/01-foundation-security.md)

### 010–018：API 部署与读迁移

- [010 独立部署边界](./commits/010-route-api-v1-to-standalone-service.md)：本段最克制、价值最高。
- [011 Session/MySQL/主数据读](./commits/011-authenticated-master-data-read.md)：必要但实现偏重。
- [012 财务/审批读](./commits/012-finance-approvals-reads.md)：角色边界有价值，Legal Entity scope 未决。
- [013 库存/物流读](./commits/013-inventory-logistics-reads.md)：receiver 和 scope-after-LIMIT 最终残余。
- [014 采购/导入读](./commits/014-purchase-import-reads.md)：方向正确，重复聚合明显。
- [015 账户/平台读](./commits/015-account-platform-reads.md)：当时接线缺口后续已修。
- [016 生产/质检/退货读](./commits/016-production-quality-returns-reads.md)：授权缺陷后续在 v1 修复。
- [017 供应商读](./commits/017-supplier-reads.md)：范围过大，适合拆分；授权后续修复。
- [018 Stage 4 checkpoint](./commits/018-stage4-read-integration-checkpoint.md)：只是集成点，不能视为质量关闭点。
- [分段总结](./segments/02-api-read-migration.md)

### 019–027：读加固与写迁移

- [019 生产读加固](./commits/019-226bfe1-production-order-read-hardening.md)：必要且克制，但旧 GET 仍可绕过。
- [020 供应商 scope 加固](./commits/020-79a833a-supplier-read-scope-hardening.md)：必要且克制，但旧 GET 仍存在。
- [021 退货授权加固](./commits/021-8475ef4-returns-read-authorization.md)：必要且克制，但旧 GET 仍存在。
- [022 Stage 5 计划](./commits/022-9faab64-stage5-write-plan.md)：长期方向合理，作为一次 Scope A 清单过重。
- [023 Stage 4 生产门禁](./commits/023-616c942-stage4-production-gates.md)：依赖、XLSX、OSS 加固必要。
- [024 写平台底座](./commits/024-b86d9a5-write-platform-foundation.md)：安全能力真实；单提交过大且改写 migration。
- [025 主数据/采购写](./commits/025-c3a04c3-master-procurement-writers.md)：迁移基本完整，附件绑定后续修复。
- [026 履约/结算写](./commits/026-154f6f4-fulfillment-writers.md)：保持 Scope A；提交当时接线不完整，后续修复。
- [027 最终集成](./commits/027-fa2581c-scope-a-write-integration.md)：源码集成完成，生产切写/升级/回滚未闭环。
- [分段总结](./segments/03-hardening-write-migration.md)

## 9. 建议的 Scope A 收口顺序

本节是审查建议，不是本轮修改授权。

1. **先封旧读绕过。** 统计旧 `/api/*` GET 调用，外部入口立即转 v1 或 410；保留兼容时也只能复用 v1 service，不能保留第二套查询/授权。
2. **恢复 append-only migration。** 还原 0000/0001，新增兼容 migration 和既有环境 reconciliation 测试。
3. **拆出 writer 激活。** deploy 只安装兼容代码和 migration；每个 command/波次凭对账 artifact 和批准记录激活。
4. **修正回滚模型。** 用 release manifest + 全 canonical fact 检查决定 rollback/forward-fix，不能以“有无 Worker 镜像”推断兼容。
5. **恢复干净环境门禁。** 修复 `pnpm-workspace.yaml` 的 `allowBuilds` 占位值，运行 Contracts/API/Worker/legacy、真实 MySQL、镜像、备份恢复和角色 UAT。
6. **做结构减法。** 合并 command executor；把 R2/R3 改为稳定领域名；生成前端 Client；拆分超大 Query 模块；在指标归零后删除旧 Next API/DB 业务层。
7. **Scope A 验收完成后再启动 Scope B。** Scope B 应独立处理 Receipt、真实物料预留/消耗、质检放行/隔离，避免用架构收口掩盖业务设计决策。

## 10. 最终裁决

这轮重构不是“完全失败”，也不是“已经生产可用”。最准确的描述是：

> 独立后端和核心安全内核已经建立，写侧技术迁移基本完成；但读侧仍有可绕过的新旧双入口，生产升级与切换控制未闭环，代码结构也尚未完成规范化减法。

因此：

- **可以保留并继续收敛当前架构，不建议推倒重写。**
- **不应把 `fa2581c` 直接发布为生产切写版本。**
- **下一步应是 Scope A 收口与简化，不是新增平台能力，也不是提前实现 Scope B。**
