# T3 工程规范化全量最终验收报告

> 验收日期：2026-08-13（Asia/Shanghai）
> 全量生产代码验收对象：`068ef0574087f81b0277ad49d1f41536a8131b18`
> 两项阻断 accepted fix：`c9874437580c2e8d1048efa5ae70c2e713a9536b`
> 结论：**GO**
> 范围：Scope A 工程、构建、数据库、部署边界和资源；不含 T4 Web 搬迁，不含 Scope B
> 写入边界：除本报告外未修改生产代码、测试、配置、依赖、lock、SQL、migration 或持久化 identity

## 1. 最终裁决

`068ef057...` 的全量验收曾因两个可重复的 clean-environment **Important** 判定 NO-GO。唯一内部写者随后在精确父提交 `75882555...` 上形成 accepted fix `c987443...`，只改根 `package.json`、legacy GET 定向测试和本报告。原 T3 按冻结矩阵在非 `codex-software` 目录独立复验，两项均闭合且直接回归全绿；因此最终裁决转为 **GO**。首次失败仍保留在下表，不以复跑覆盖。

| ID | 原 Important | accepted fix | 冻结复验 | 终态 |
| --- | --- | --- | --- | --- |
| T3-I-001 | clean frozen install 后直接 `pnpm typecheck` / `pnpm verify:local` 因缺少 Contracts `dist` 失败 | 根 `typecheck` 先执行 `build:contracts`，再依次执行 Web、Contracts、API、Worker typecheck；未改 exports、tsconfig、依赖或 lock | 新非标准目录 frozen install 后确认 `dist` 不存在；直接 `typecheck` exit 0，随后 `verify:local` exit 0 | **CLOSED** |
| T3-I-002 | legacy GET 测试硬编码 `/codex-software/` basename，其他目录稳定 `354 pass / 1 fail / 0 skip` | 用 `fileURLToPath(root)` 与 `path.relative` 生成仓库相对 POSIX 路径；18 条清单和 410-only helper 断言保留 | 同一非标准目录 non-MySQL `355/355`、Web system `4/4`；定向测试 `2/2`，0 fail / 0 skip | **CLOSED** |

无 Critical；两个 Important 均有精确增量、独立复验和直接回归证据，未发现新的未解释 Important。

## 2. 基线、父链和差量边界

- 首轮全量入口 HEAD 精确为 `068ef0574087f81b0277ad49d1f41536a8131b18`，入口工作树 clean，detached HEAD；其父为 `654ed1f22505004feb3d5d92f296532cc54b0ea6`。
- 原 T3 报告提交为 `75882555fc0f4e224a2c5b53bd7b0f0df4ebd962`，精确父提交为 `068ef057...`。
- accepted fix 为 `c9874437580c2e8d1048efa5ae70c2e713a9536b`，精确父提交为 `75882555...`；复验入口从原报告提交 clean checkout 到该 SHA，未重写历史。
- `c987443...` 相对原报告只改 `package.json`、`apps/api/test/legacy-get-boundary.test.mjs` 和同一 T3 报告；`git diff --check` exit 0。
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
| `corepack pnpm install --frozen-lockfile`（初次全量与 fix 后独立 clean checkout） | PASS；fix 复验为 Node v24.19.0、pnpm 11.9.0、4 workspace projects、682 packages、0 download；lock 未改，安装后 Contracts `dist` 仍不存在 |
| `corepack pnpm typecheck`（fix 后 clean install、初始无 dist） | PASS / exit 0；日志确认 `build:contracts → typecheck:web → contracts → api → worker`，4/4 |
| `corepack pnpm verify:local`（fix 后非 `codex-software` clean checkout） | PASS / exit 0；non-MySQL 54 files、355/355、0 skip；Web system 4/4、0 skip；Next 47/47 pages |
| `corepack pnpm lint:baseline` | PASS；0 errors / 102 warnings；19 个 file/rule warning entry 均有非空逐项 reason |
| `corepack pnpm docker:check-context` | PASS；17 exclusions |
| `corepack pnpm deploy:check-env-contract` | PASS；46 declared variables；Web/API/Worker 显式注入；migrator debt 被明确承认 |
| `node --test apps/api/test/legacy-get-boundary.test.mjs`（fix 后非标准目录与 accepted checkout） | 两处均 PASS；各 2/2、0 fail / 0 skip；显式枚举 18 条并逐项检查 410-only helper |
| `corepack pnpm typecheck` 与 `lint:baseline`（fix accepted checkout 直接回归） | PASS；TypeScript 4/4；ESLint 0 errors / 102 frozen warnings |
| `corepack pnpm verify:mysql` | PASS；8 integration files、21/0/0 |
| release/deployment/command 定向三文件 | PASS；13 + 17 + 6 = 36 tests，0 fail / 0 skip |
| `corepack pnpm build:web:preview` | PASS；Vinext/Vite 五阶段完成，46 个 Web API route 文件保持 |
| `corepack pnpm build:web:production` | PASS；Next 16.2.11、47/47 pages、TypeScript PASS |
| `bash -n deploy/aliyun/deploy.sh rollback.sh scripts/activate-writers.sh` | 3/3 PASS |
| runtime-only Compose `config -q` 与 JSON 展开 | PASS；三服务 loopback-only、read-only、cap-drop ALL、no-new-privileges |
| Compose `--dry-run up -d --no-build app api worker` | exit 0；仅打印计划，验后 `topology-scm-*` containers/network 为 0 |

给定路径的 355 个 non-MySQL 测试与 21 个 MySQL 测试共同覆盖：旧 GET/写退役、session/RBAC/data scope/scope-before-LIMIT、CSRF/Origin、Step-up、事务/lock/CAS/deadline、幂等与 unknown outcome、audit/outbox、file quarantine/ACL、Worker lease/retry/dead/fence、migration history、release/rollback。所有 runner 均显式禁止 skip。

### 4.2 clean gate 闭合与增量边界

- 首次失败定位准确：T3-I-001 是根 typecheck 编排/生成物依赖，T3-I-002 是测试路径可移植性；accepted fix 仅触及对应的 package script 与测试路径生成。
- fix 后在新的非 `codex-software` 目录从无 `dist` 的 frozen install 起步，直接 `typecheck` 和完整 `verify:local` 均通过，证明不是依赖旧 checkout 生成物或特定 basename 的偶然绿色。
- 本轮只复核两个已确认问题及直接回归。真实 MySQL、Docker、migration、部署/回滚和供应链门禁均来自同一生产祖先 `068ef057...`，且 fix 未改其代码、配置、依赖、lock、SQL/migration 或镜像定义，因此不做昂贵重复执行。

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

- 严格区分三层证据：`068ef057...` 的全量只读验收、`c987443...` 的两个目标文件修订，以及本报告的 docs-only 最终提交。
- 冻结复验只检查已确认的 T3-I-001/T3-I-002 和直接回归，不广泛重跑未受差量影响的 MySQL、Docker、供应链或部署门禁。
- 使用新的非 `codex-software` detached clean worktree，从 frozen install 且 Contracts `dist` 不存在的状态起步，避免复用先前 generated artifacts。
- archive、Web health、T4 和 Scope B 的原边界不变；不复制 archive、不使用生产 OSS/RAM 凭据、不进入 T4/Scope B。

### 偏离与处置

- 验证本身无偏离。清理时 `git worktree remove --force` 已解除临时 worktree 注册，但 Windows 长路径令目录本体和当前 `node_modules` 出现残留；在确认两个绝对路径均属于本任务后，使用 Node 长路径文件 API 精确删除并复核为 0。
- 没有为了复验通过而修改 package script、测试、生产代码、配置、依赖或 lock；唯一 T3 写入是本报告。

### 未决项

- 没有未闭合的 Critical/Important。第 7 节的 25 advisories/14 High、102 lint warnings、migrator env、根 Web/T4、legacy 删除事实和构建 warnings 继续作为已批准的非阻断债务。
- 不 push、不 merge、不 deploy、不使用生产凭据、不进入 Scope B；Scope A 后续是否进入发布流程由主任务另行裁决。

## 9. 资源与终态

- 已删除本任务精确容器：MySQL、provider、API runtime、Worker runtime、Web runtime。
- 已删除精确 network `codex-t3-scopea-068ef057-net` 与三项 `codex-t3-scopea-068ef057-*:acceptance` 镜像。
- 已删除两个 `codex-t3-scopea-068ef057-*-019ff7d2` 临时 checkout及本任务创建的 worktree build/install 目录。
- 清理后：task containers/networks/images/temp 均 0；`33320/33321/33322/33326` 监听均 0；archive restore temp 0。
- 本轮冻结复验创建的唯一临时 worktree `t3-freeze-c987443-019ff7d2`、其注册与目录均已删除；当前 checkout 本轮生成的 `node_modules` 和 `packages/contracts/dist` 均已删除。
- 本轮没有创建 MySQL、Docker container/network/image、服务、监听端口或生产凭据。
- 未删除共享基础镜像、未知 Docker 资源、主 checkout archive、生产数据或任何非本任务资源。
- 本报告提交前 accepted fix worktree 位于 `c987443...`；除本报告外没有 tracked 变更。报告形成单独 docs-only 提交，精确父提交必须为该 accepted fix SHA。

## 10. 终止声明

最终推荐：**Scope A 工程规范化全量门禁 GO**。T3-I-001 与 T3-I-002 已在 accepted fix `c987443...` 上以非标准目录、无预存 Contracts `dist` 的 clean frozen 环境独立闭合；所有直接回归通过，无未解释 Critical/Important。第 7/8 节债务继续保留为计划明确接受的非阻断项。本任务在 docs-only 报告提交后停止，等待主任务吸收最终 GO；不 push、不 merge、不 deploy、不使用生产凭据、不修代码、不启动 Scope B。

## 11. 阻断修订冻结复验明细

### 来源与冻结边界

- 来源：用户已授权原 T3 在 accepted fix `c987443...` 上只做冻结复验与最终报告更新。
- 入口核对：原 T3 worktree clean、HEAD=`75882555...`；fix 精确父为该提交，差量仅 `package.json`、legacy GET 测试和本报告；detached checkout 后 HEAD 精确为 fix SHA。
- 本轮没有变更两个修订目标文件；最终 diff 只能包含本报告。

### 设计决定

- T3-I-001：确认根 `typecheck` 先执行一次 `build:contracts`，再依次执行 Web、Contracts、API、Worker typecheck；package exports、tsconfig、依赖与 lockfile 均未在 fix 中改变。
- T3-I-002：确认测试使用 `fileURLToPath(root)` 与 `path.relative` 生成仓库相对 POSIX 路径，不再依赖仓库 basename；18 条 legacy GET 清单及 410-only helper 检查不变。

### 冻结命令与结果

- PASS：非标准目录 `t3-freeze-c987443-019ff7d2`，Node v24.19.0、pnpm 11.9.0；`corepack pnpm install --frozen-lockfile` 安装 4 workspaces / 682 packages / 0 download，安装前后 Contracts `dist=false`，Git clean。
- PASS：同目录直接 `corepack pnpm typecheck` exit 0；Contracts build 后四套 TypeScript 4/4，`dist=true` 符合新编排预期。
- PASS：同目录直接 `corepack pnpm verify:local` exit 0；non-MySQL 355 tests、355 pass、0 fail、0 skip；Web system 4/4、0 fail、0 skip；生产 Web build Next 16.2.11、47/47 pages。
- PASS：同目录 `node --test apps/api/test/legacy-get-boundary.test.mjs` 为 2/2、0 fail、0 skip；测试名与断言确认 18 条 legacy business GET 均走 410-only helper。
- PASS：accepted fix checkout 的同一定向测试 2/2；根 `typecheck` 四套 4/4；`lint:baseline` 为 0 errors / 102 warnings；`git diff --check HEAD^ HEAD` exit 0。
- PASS：复验后临时 worktree 注册/目录、当前 `node_modules`、Contracts `dist` 均为 0；accepted fix checkout 在编辑本报告前 Git clean。
