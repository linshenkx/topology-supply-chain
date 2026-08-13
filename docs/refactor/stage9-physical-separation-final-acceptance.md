# Stage 9 物理分离最终验收报告

> 验收日期：2026-08-13（Asia/Shanghai）  
> 候选：`2bae0ebe80ab7bf8a98fbbeeebf6745684ec87f3`（T2 accepted）  
> T1 基线：`228de77b97e42e8b571871048c425ebd5712cbc0`  
> 最终裁决：**NO-GO（唯一阻断：migrator Docker target 以 root 默认身份运行）**

## 1. 入口、范围与环境

- T3 cwd：`C:\Users\15588\.codex\worktrees\89d1\codex-software`；入口 `HEAD` 精确为候选、detached，唯一未提交项为本报告。
- owner checkout：`D:\Dev\myProject\codex-software`；验收时 `HEAD` 同为候选且 clean，全程只读。
- Node `v24.19.0`、pnpm `11.9.0`、Docker `29.6.2`；无审批。
- 未修改生产代码、测试、配置、依赖、lock、SQL/migration 或 identity；未进入 Scope B，未使用生产凭据，未 push/PR/deploy，未写 owner checkout。本报告为唯一仓库写入。

## 2. 已通过的既有独立门禁

| 项目 | 命令/检查 | 结果 |
| --- | --- | --- |
| 物理所有权 | root package/read-only layout 检查 | PASS；tracked 根一级 10（≤24），根仅编排，`apps/web` 独立。 |
| 反向依赖与环 | `pnpm architecture:check` | PASS；179 files、143 internal edges、`database -> apps/web = 0`、`cycles = 0`。 |
| migration/release/identity 冻结 | 对 T1 的定向 `git diff --exit-code`、release manifest | PASS；5 migrations、35 commands、29 resources、generation=2、`legacyWriterCompatible=false`；release `10833` bytes、SHA-256 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`。 |
| legacy snapshot / live boundary | `pnpm archive:verify-legacy-source`、API/Web boundary tests | PASS；18 routes、184,320 bytes、SHA-256 `df2605b0471e3d8f1be7146c3404dbe65a972d958159112c009844b6771a94a9`、敏感扫描 clean；18 live GET 精确 410，archive 343。 |
| archive 343 owner 现场 | owner 上 `archive-assets.mjs verify`、`restore-dry-run` | PASS；343 archived assets；dry-run `writePerformed=false`、343 源 SHA 已验证、343 目标不存在、`overwriteAllowed=false`；29 legacy-deliveries / 278 deliveries / 30 working-notes / 6 diagrams，15,832,433 bytes，聚合 SHA-256 `0e7480df6e4bd51c83df50d7ef65cef4bfb56129b0b206f83c29544c95c66be7`。 |
| migrator 环境契约 | `pnpm deploy:check-env-contract` | PASS；无 migrator `env_file`，仅 `DATABASE_URL`、`DB_SSL`、`DB_SSL_REJECT_UNAUTHORIZED` 三项；46 环境变量责任契约通过。 |
| 质量与审计 | `pnpm lint`、`pnpm lint:baseline`、`pnpm audit:policy` | PASS；ESLint 0 errors / 0 warnings；production audit 全 0。full tree 唯二批准例外为 dev-only `@topology/web -> vinext@0.0.50 -> image-size@2.0.2` 的 High `GHSA-5p2g-fcmc-qvqq`、`GHSA-w3rx-r6r6-pgpr`，policy 逐路径/版本/咨询编号 fail-closed，到期 `2026-09-12`。 |
| TS、非 MySQL 与 Web | `pnpm typecheck`、`pnpm test:non-mysql`、`pnpm build:web:preview`、`pnpm build:web:production` | PASS；Contracts/shared/Web/API/Worker TS 通过；non-MySQL 54 files、359 pass、0 fail、0 skip（安全、事务、并发、CAS、outbox/worker fence）；Vinext preview 46 routes、Next production 47/47。 |
| SupplierWorkspace | `node --test tests/supplier-performance-lifecycle.test.mjs` | PASS；5/5，空数组回退 relation-visible factories，非空 suppliers 优先。 |

## 3. 本轮补齐证据

### A. 真实 MySQL：PASS

- 使用仓库 canonical 入口与责任流：对精确一次性 loopback MySQL 8.4 资源分别执行 preflight → `pnpm db:migrate:mysql` → history 5/5 → repeat migrate，再以 `pnpm test:mysql` 后台隐藏运行；`MYSQL_WRITE_TEST_URL`、`MYSQL_R2_TEST_URL`、`MYSQL_R3_TEST_URL` 均指向已 canonical-migrated 的独立空库，admin/payment 亦为精确临时库。
- MySQL `8.4.11`，`REPEATABLE-READ`；日志与 exit code 写入仓库外精确临时目录，轮询均为短读取。
- 完整 harness 结果：**8 files、21 tests、21 pass、0 fail、0 skip**，`duration_ms=176614.4814`，exit 0。
- 历史说明：此前两次同步长调用均被平台约 120 秒截断；一次错误地用未迁移空库得到环境性失败。两者不作为候选代码结论，本轮 canonical 后台结果取代该缺口。

### B. 实际 runtime：API/Worker/Web 通过；migrator 安全身份失败

| workload | 启动与端点/边界 | 结果 |
| --- | --- | --- |
| API | loopback `33101`；`GET /api/v1/health/live` = 200；`GET /api/v1/health/ready` = 200（mysql、worker-providers 均 ok） | PASS |
| Worker | loopback `33102`；`GET /health/live` = 200；`GET /health/ready` = 200 | PASS |
| Web | loopback `33100`；无 OSS 生产凭据下 `GET /api/health` = **503**，`application=ok`、`database=ok`、`objectStorage=failed`；`GET /api/session` = 401 | PASS；受控 fail-closed，非伪绿。 |
| API / Worker / Web 安全 | Docker inspect：用户分别 `api` / `worker` / `nextjs`；`ReadonlyRootfs=true`、`CapDrop=[ALL]`、`no-new-privileges:true`。对三者 `touch /app/stage9-readonly-probe` 均以 `Read-only file system` 拒绝。 | PASS |
| Migrator 边界 | `--target migrator` 重新构建成功（image SHA `6141f1db308a1ff44dca6ba45e718455a0a109918025c46e289a0f68cd44db84`）；只创建未启动容器，命令精确为 `["pnpm","db:migrate:mysql"]`，仅传入三项 DB 变量，`ReadonlyRootfs=true`、`CapDrop=[ALL]`、`no-new-privileges:true`。 | 边界 PASS；未执行任何迁移。 |
| **Migrator 身份** | 同一只创建容器的 Docker inspect：`Config.User` 为空；`infrastructure/docker/web.Dockerfile` 的 `migrator` stage 未声明 `USER`，Docker 默认 root。 | **FAIL（可复现的候选安全缺陷）** |

API 与 Worker 使用本轮专属 loopback MySQL 和最小 provider health mock；未访问任何生产服务或凭据。Web 503 是故意不提供 OSS 凭据的 fail-closed 验证。

## 4. 未执行项、例外与资源

- 未执行：migrator 的迁移命令（合同明确禁止执行未知或不可逆迁移）；生产凭据/生产环境、Scope B、push、PR、deploy、owner 资产写入或删除。
- 未知资源未删除。`node:22-alpine` 为通用基础镜像，未按“精确命名”规则删除。
- 已删除并复核无残留：`stage9-t3-2bae0ebe-mysql-final2`、`stage9-t3-2bae0ebe-final2-{api,worker,web,provider,migrator}`、network `stage9-t3-2bae0ebe-final2-net`、四个同前缀 acceptance 镜像，以及仓库外日志目录 `stage9-t3-2bae0ebe-final2`。验收自有资源为 **0**。

## 5. 最终裁决

**NO-GO。** 所有结构、冻结 identity、archive 343、真实 MySQL（8/21/0/0）、API/Worker/Web runtime、Web 无凭据 fail-closed、质量、审计、Contracts/shared/Web/API/Worker、事务/并发与资源清理门均通过；但 migrator target 在候选版本中以 root 默认身份运行，不满足本验收的 non-root 运行时安全门。该事实来自只读 Dockerfile 与未启动容器 inspect，未作修复。除以非 root 用户运行 migrator 外，不应变更其他范围；修复后须在新候选重新验收该 target。
