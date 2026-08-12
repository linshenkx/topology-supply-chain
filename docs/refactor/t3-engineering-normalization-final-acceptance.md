# T3 工程规范化全量最终验收报告

> 验收日期：2026-08-13（Asia/Shanghai）
> 生产代码验收对象：`068ef0574087f81b0277ad49d1f41536a8131b18`
> 结论：**NO-GO**
> 范围：Scope A 工程、构建、数据库、部署边界和资源；不含 T4 Web 搬迁，不含 Scope B
> 写入边界：除本报告外未修改生产代码、测试、配置、依赖、lock、SQL、migration 或持久化 identity

## 1. 最终裁决

当前实现的源码行为、真实 MySQL、三镜像和部署安全门禁在给定的 `codex-software` 路径上均通过，但 clean environment 门禁存在两个可重复的 **Important** 阻断项。Stage 8 要求任一未解释 Critical/Important 即 NO-GO，因此不能用后续定向通过覆盖首次失败。

| ID | 级别 | 客观失败 | 复现与诊断 | 裁决 |
| --- | --- | --- | --- | --- |
| T3-I-001 | Important | clean frozen install 后直接执行 `pnpm typecheck` / `pnpm verify:local` 失败 | 新 checkout 中 `packages/contracts/dist` 不存在；根 `typecheck` 先运行 Contracts 的 `--noEmit`，随后 API 按 package exports 解析 `@topology/contracts` 的 `dist`，产生 `TS2307` 及连带类型错误，exit 2。先运行既有 `pnpm build:contracts` 后四套 TypeScript 全通过 | 发布候选门禁依赖预存 generated `dist`，不满足 clean repeatability；阻断 |
| T3-I-002 | Important | clean checkout 不叫 `codex-software` 时 non-MySQL suite 稳定失败 | `apps/api/test/legacy-get-boundary.test.mjs` 用 `url.pathname.split("/codex-software/")[1]` 枚举 18 个旧 GET；任意其他目录名得到 18 个 `undefined`。同一 clean checkout 连续两次均为 `354 pass / 1 fail / 0 skip`；给定路径复跑为 `355/0/0` | 测试依赖绝对目录 basename，不满足 clean environment 可重复性；阻断 |

无 Critical。除上述两项外没有新的未解释 Important。

## 2. 基线、父链和差量边界

- 入口 HEAD 精确为 `068ef0574087f81b0277ad49d1f41536a8131b18`，入口工作树 clean，detached HEAD。
- 当前提交父为 `654ed1f22505004feb3d5d92f296532cc54b0ea6`。
- T1 accepted 尾提交 `a9e96357b252fbfaf80ca92d23ffcb6e86a557b4` 是验收对象祖先；T2 为 12 个线性提交、0 merge。
- T2 差量为 24 files、`943 insertions / 788 deletions`；`git diff --check` 通过。
- T2 未改 `package.json`、`pnpm-lock.yaml`、任一 workspace package、Contracts、SQL/schema/migration、release/deploy/rollback、三 Dockerfile 或持久化 identity。
- release manifest 原生字节 SHA-256 保持 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`：5 migrations、35 commands、29 resources、writer generation 2、`legacyWriterCompatible=false`。
- Scope B 差量扫描仅命中既有 `receiver` 角色 UI 条件，没有新增 Receiver/LegalEntity 模型；未发现 PurchaseReceipt、BOM 实际库存预留/领料/消耗、质检后库存放行/隔离、真实银行付款或新业务状态机。

## 3. 结构、LOC、依赖与 archive

### 3.1 生产源码

复用 T1 口径统计 Web、API/Worker/Contracts src、DB、Cloudflare adapter/Sites tooling、ambient types 与根 TypeScript config：

| 指标 | T1 accepted | 当前 | 结论 |
| --- | ---: | ---: | --- |
| 生产 TypeScript 文件 | 179 | 181 | 新增 supplier read-model 与前端 lifecycle helper |
| 生产物理 LOC | 35,885 | 35,902 | `+17`，不是机械追求净减 LOC |
| 最大生产文件 | suppliers `index.ts` 1,840 | suppliers `index.ts` 1,460 | `-380`，最大文件下降 20.7% |
| `app/page.tsx` | 819 | 547 | `-272` |
| 新拆 read-model / lifecycle | 0 | 439 / 62 | 真实职责抽取，公开注册入口未变 |

181 个生产文件形成 438 条相对 import；剔除 type-only 后 351 条运行依赖，**运行时循环 0**。保留一条 auth `index.ts ↔ writes.ts` 的 type-only 双向关系，不生成 JS 运行环。`db -> app/lib` 4 条目录所有权反向边与 T1 证据一致，没有扩大；属于已记录的语义 owner 债务，不构成本次新增 runtime cycle。

### 3.2 模块、OpenAPI 与 Web owner

- production API 实际加载 manifests：`r2.master-procurement`、`r3.fulfillment-writes`。
- `app.swagger()` 在 ready 后得到 36 paths / 61 HTTP methods，包含两个 health 与 suppliers；普通测试中的 OpenAPI/模块注册断言全部通过。
- 根 Web 保持 46 个 `app/api/**/route.ts`、91 个 tracked `app/**` 文件、Next/React/ReactDOM 三项根依赖及 8 个 `db:/deploy:/admin:` 根脚本入口。
- Next standalone 的 `/app/server.js`、`/app/public`、`/app/.next/static` 均存在。
- 因此 T4/apps-web 继续 NO-GO 是有证据的已批准边界，不影响已有 Web/API/Worker 运行分离，也不在 T3 修复或搬迁。

### 3.3 根目录与 archive

- T1 主 checkout `D:\Dev\myProject\codex-software` 与 T3 worktree 均精确位于 accepted SHA 且 clean。
- 主 checkout 根一级条目为 50；T3 Git worktree 为 41。差异来自 343 项 archive 内容均为 ignored/protected，不由 Git worktree 复制；这与 Stage 8 对 T1 主 checkout 的明确设计一致。
- 在资产 owner 的主 checkout 执行 `node scripts/archive-assets.mjs verify`：343/343 通过，状态 `archived`，总计 15,832,433 bytes；分类为 29 legacy deliveries、278 deliveries、30 working notes、6 diagrams。
- 23 个资产含 25 项 secret-like/credential-like 分类证据，只记录类别、不输出值；仍未进入 Git/Docker context。
- `node scripts/archive-assets.mjs restore-dry-run` 返回只读恢复计划：343 archived sources verified、343 destinations absent、overwrite=false、`writePerformed=false`。
- Docker context contract 覆盖 17 个 archive/cache/generated 排除项。

## 4. 安装、类型、lint、测试与构建结果

### 4.1 命令和计数

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm install --frozen-lockfile`（独立 clean Git archive checkout） | PASS；4 workspace projects、682 packages、0 download、pnpm 11.9.0、lock policy PASS；lock 未改 |
| `corepack pnpm typecheck`（clean install 后，无 dist） | **FAIL / exit 2**；T3-I-001 |
| `corepack pnpm build:contracts` 后逐项 `typecheck:web/contracts/api/worker` | 4/4 PASS |
| `corepack pnpm lint:baseline` | PASS；0 errors / 102 warnings；19 个 file/rule warning entry 均有非空逐项 reason |
| `corepack pnpm docker:check-context` | PASS；17 exclusions |
| `corepack pnpm deploy:check-env-contract` | PASS；46 declared variables；Web/API/Worker 显式注入；migrator debt 被明确承认 |
| `corepack pnpm test:non-mysql`（clean checkout basename 非 `codex-software`，连续两次） | **FAIL**；每次 355 tests：354 pass / 1 fail / 0 skip；T3-I-002；Web system 因聚合 fail-fast 未进入 |
| `corepack pnpm test:non-mysql`（给定 accepted worktree） | PASS；54 files、355/0/0；Web system 4/0/0 |
| `corepack pnpm verify:mysql` | PASS；8 integration files、21/0/0 |
| release/deployment/command 定向三文件 | PASS；13 + 17 + 6 = 36 tests，0 fail / 0 skip |
| `corepack pnpm build:web:preview` | PASS；Vinext/Vite 五阶段完成，46 个 Web API route 文件保持 |
| `corepack pnpm build:web:production` | PASS；Next 16.2.11、47/47 pages、TypeScript PASS |
| `bash -n deploy/aliyun/deploy.sh rollback.sh scripts/activate-writers.sh` | 3/3 PASS |
| runtime-only Compose `config -q` 与 JSON 展开 | PASS；三服务 loopback-only、read-only、cap-drop ALL、no-new-privileges |
| Compose `--dry-run up -d --no-build app api worker` | exit 0；仅打印计划，验后 `topology-scm-*` containers/network 为 0 |

给定路径的 355 个 non-MySQL 测试与 21 个 MySQL 测试共同覆盖：旧 GET/写退役、session/RBAC/data scope/scope-before-LIMIT、CSRF/Origin、Step-up、事务/lock/CAS/deadline、幂等与 unknown outcome、audit/outbox、file quarantine/ACL、Worker lease/retry/dead/fence、migration history、release/rollback。所有 runner 均显式禁止 skip。

### 4.2 clean gate 失败与源码行为的区分

- T3-I-001 不是源码 TypeScript 本身失败：Contracts build 后四套 TS 全绿；失败点是 clean gate 的顺序/生成物依赖。
- T3-I-002 不是 18 个退役 GET 行为失败：给定目录名下同一 suite 为 355/355，Web system 的 suppliers/approvals 都返回精确 410；失败点是测试把仓库 basename 硬编码为 `codex-software`。
- 本任务按授权只诊断和分级，未改 package script、测试或源码来让门禁通过。

## 5. 真实 MySQL 与 migration

- 任务专属 `mysql:8.4` 实际版本 8.4.11，事务隔离 `REPEATABLE-READ`，仅绑定 `127.0.0.1:33326`，使用本地一次性凭据。
- `write`、`r2`、`r3` 三个数据库分别执行 `fresh preflight (0/5) → migrate → history (5/5) → repeat migrate`，全部通过；最终各有 5 条 canonical history，最大 `created_at=1786521600000`。
- 第四个 payment DB 用于真实行锁并发测试。
- 21 个真实测试、0 fail、0 skip，覆盖：
  - platform auth/OTP/CSRF/idempotency/scope/quarantine；
  - R2/R3 transaction、CAS、审批、库存/财务守恒、audit/outbox/replay/fence；
  - Worker fan-out/domain event/lease/dead-letter/disabled fence；
  - fresh/dirty/legacy rollback fail-closed、partial activation、disabled-ready、0004 upgrade、canonical upgrade/repeat/divergent history；
  - payment row-lock serialization。

## 6. Docker、runtime 与发布边界

### 6.1 fresh 镜像

三个 runner 均用 `docker build --no-cache`、pnpm 11.9.0 frozen lock policy 构建：

| 镜像 | Image SHA-256 | bytes | User | context |
| --- | --- | ---: | --- | ---: |
| API | `be681cee8cc2160e45432200f2b2c2b0c3be932e22132f117e4d5d80d6b70920` | 189,952,630 | `api` | 3.60 MB |
| Worker | `319e43fa19712036e9dadd491d68f4baaaeefa71361f2e7e705137e622930082` | 169,048,856 | `worker` | 36.80 kB |
| Web | `3674ec2f3aa94ddcea2653cd76a1157851141d2e3647b8acbaba164f1194b62b` | 189,874,301 | `nextjs` | 8.42 MB |

API closure 含 Fastify/mysql2、不含 Next/API src；Worker closure 含 mysql2、不含 Fastify/Next、根 node_modules 或 vendor tar；Web standalone 不含 `apps/api`/`apps/worker`。三个 `/app` 写探针都因 read-only filesystem 失败。

### 6.2 真实运行态

- API：non-root、read-only、cap-drop ALL、no-new-privileges；Docker health healthy；live 200、ready 200。
- Worker：同上；Docker health healthy；在 `files/outbox/reminders.worker` 三个 generation-2 fence 全为 `enabled=0` 时，ready 仍为 200，符合“健康待命但不消费”语义。
- request-id：对不存在路由传入 `codex-t3-068ef057-request-001`，404 header 与 JSON `requestId` 精确保持。
- Web：non-root、read-only、cap-drop ALL、no-new-privileges；standalone 路径完整；`/api/session` 未登录为 401。
- Web 未使用生产 OSS/RAM 凭据，因此 `/api/health` 为预期的受控 503：application/database ok、objectStorage failed，响应未泄露凭据。Docker health 因同一路径标记 unhealthy；这与 T1 已接受的外部发布门禁及 T4 NO-GO 原因一致，不把无真实 OSS 的本地 503 伪报为 200。

### 6.3 deploy / activation / rollback

- release tests：普通 deploy writer activation 路径为 0；显式 activation 默认空 allowlist fail-closed。
- 真实 MySQL：partial activation 只改所选 resource，事务化、幂等；空/未知/重复列表和证据失败均零变化。
- rollback：same generation exact contract 通过；pre-Scope-A、schema、generation、command、resource、minimum-version 和 missing manifest 均 fail closed；不接受 legacy override。
- migration-profile Compose config 在仓库中没有真实 `deploy/aliyun/.env.production` 时 exit 1；runtime-only config 正常通过。这正是已记录的 migrator `env_file` over-injection/发布现场配置债务，不使用生产凭据补齐。

## 7. 供应链与保留债务

| 项目 | 当前证据 | 分级 |
| --- | --- | --- |
| 生产依赖 audit | `pnpm audit --prod --audit-level=low`：0 known vulnerabilities，exit 0 | PASS |
| 全依赖 audit | 25 findings：14 high、8 moderate、3 low、0 critical；主要在 brace-expansion、image-size、js-yaml、react-server-dom-webpack、undici、vite/esbuild 等开发/预览树；exit 1 | 已接受的非阻断 baseline；本任务禁止升级 lock |
| ESLint | 0 errors / 102 warnings，所有 warning entry 有逐项冻结 reason | 已接受的非阻断 debt |
| legacy 删除 | 18 个 410 边界绿，但没有新增生产零调用/回滚窗口事实 | 保留，不为 LOC 强删 |
| migrator env | `env_file` over-injection 明确记录；无真实 `.env.production` 时 migration-profile config 不可展开 | 已接受的非阻断发布债务 |
| 根 Web/T4 | 46 routes、根 importer/DB/migrator/release/health/standalone owner 未机械独立 | T4 NO-GO；不阻断 Scope A 运行分离，但 T3 不搬迁 |
| build warnings | Next workspace-root/multiple-lockfile；Vinext route classification、chunk >500 kB、dynamic import；proxy 检测；Docker registry ETIMEDOUT/慢下载重试 | 构建最终成功；保留并记录 |
| archive worktree 可见性 | ignored 343 项只在主 checkout；T3 worktree 不复制，但同 SHA 的 owner 现场 343/343 verify/restore dry-run 通过 | 已解释的资产现场边界 |

## 8. Implementation Notes：决定、偏离与未决项

### 决定

- 严格把 accepted 生产 SHA 与 docs-only 报告提交分开；所有运行证据来自 `068ef057...`。
- 因 archive 内容按设计不随 Git worktree 传播，在同一 accepted SHA、clean 的主 checkout 只读验收真实资产；不复制或修复到 T3 worktree。
- 无生产凭据时保留 Web health 的受控 503，不伪造 OSS 绿色。
- 两个 clean gate 问题均停留在诊断；不利用 T3 越权修 test/script。

### 偏离

- `verify:local` 无法从 clean install 完成；为继续区分 gate 编排与源码行为，后续只用既有 `build:contracts` 生成 dist，再逐门复验。这个补充步骤不改变首次失败结论。
- clean checkout 路径测试失败后，在用户给定的 `codex-software` 路径完整复跑；该成功只证明行为本身，不抵销路径可移植性失败。

### 未决项

- Scope A 最终状态应保持 NO-GO，等待主任务决定是否授权原责任任务对 T3-I-001/T3-I-002 各做一次极窄修订并重新 T3；本任务不自动派修。
- 不进入 T4，不进入 Scope B，不 push/merge/deploy。

## 9. 资源与终态

- 已删除本任务精确容器：MySQL、provider、API runtime、Worker runtime、Web runtime。
- 已删除精确 network `codex-t3-scopea-068ef057-net` 与三项 `codex-t3-scopea-068ef057-*:acceptance` 镜像。
- 已删除两个 `codex-t3-scopea-068ef057-*-019ff7d2` 临时 checkout及本任务创建的 worktree build/install 目录。
- 清理后：task containers/networks/images/temp 均 0；`33320/33321/33322/33326` 监听均 0；archive restore temp 0。
- 未删除共享基础镜像、未知 Docker 资源、主 checkout archive、生产数据或任何非本任务资源。
- 本报告提交前生产验收 worktree 回到 `068ef057...` 且 Git clean；报告形成单独 docs-only 提交，父提交必须为该 accepted SHA。

## 10. 终止声明

最终推荐：**Scope A 工程规范化全量门禁 NO-GO**，仅因 T3-I-001 与 T3-I-002 两个 clean-environment Important。其余已执行矩阵为绿色或属于计划明确接受的非阻断债务。本任务在报告提交后停止，等待主任务向用户提出 Scope A 最终 GO/NO-GO；不 push、不 merge、不 deploy、不使用生产凭据、不修生产代码、不启动 Scope B。

## 11. 阻断修订 Implementation Notes（待 T3 复验）

### 来源与冻结边界

- 来源：主任务已授权对 T3-I-001 与 T3-I-002 各做一次极窄修订。
- 仅允许调整根 `package.json` 的 typecheck 编排、`apps/api/test/legacy-get-boundary.test.mjs` 的仓库相对路径生成，以及本节验证记录。
- 本报告结论继续保持 NO-GO；修订完成不代表 T3 或 Scope A 自动转为 GO。

### 设计决定

- T3-I-001：根 `typecheck` 先且仅先执行一次 `build:contracts`，再依次执行 Web、Contracts、API、Worker typecheck；不改变 package exports、tsconfig、依赖或 lockfile。
- T3-I-002：以 `fileURLToPath(root)` 取得仓库根路径，再用 `path.relative` 生成路由文件相对路径，并按 POSIX `/` 归一化；移除仓库 basename 假设，18 个 legacy GET 清单和 410 body 断言保持不变。

### 偏离、权衡与未决项

- 偏离：无；实现仅触及冻结的两个目标文件与本节记录。
- 权衡：`pnpm typecheck` 会有意生成可再生的 Contracts declarations，换取 clean install 后 API/Worker NodeNext 解析的确定性；没有在 `typecheck:api` 内再次触发构建，避免根调用链重复执行。
- 未决项：修订结果必须由原 T3/主任务独立复验并作最终裁决。

### 验证记录

- PASS：以限定 `git clean -fdX -- packages/contracts/dist` 删除 declarations 后，`pnpm typecheck` exit 0；日志确认 `build:contracts` 先于四组 typecheck 且无递归。
- PASS：当前 checkout 执行 `node --test apps/api/test/legacy-get-boundary.test.mjs`，2/2 passed；仍显式断言 18 个 legacy business GET。
- PASS：在 `C:\Users\15588\AppData\Local\Temp\topology-t3-portability-eafd0ce` 创建不含 `codex-software` basename 的 detached clean checkout，同一定向测试 2/2 passed，测试后 Git 仍 clean；临时 worktree 随后已精确删除。
- PASS：`pnpm verify:local` exit 0；non-mysql 54 files、355/355 tests、0 skipped，Web system 4/4，生产 Web build 完成；既有 102 条 ESLint warning baseline 未变化。
- PASS：提交前 `git diff --check` exit 0。
