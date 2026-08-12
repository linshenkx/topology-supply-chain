# Stage 6 Scope A 独立验收报告

## 1. 结论

**GO**。

最终验收对象是 exact SHA `b15e5bdee98230796ba7d42fe35f24dcce057ba5`，其父为本报告原 NO-GO docs-only 提交 `f38ffab0fa9c4959b6f503f9e78733812a866000`，再前一提交为原验收实现基线 `9e2a8f70acebc35b6924860b9597ebe0b3421903`。

原 NO-GO 的两个阻断点已做极窄差量复验并闭合，未重跑未受影响的全量矩阵：

1. `b15e5bd` 仅在 `deploy/aliyun/docker-compose.yml` 为 Web/app 增加 `cap_drop: [ALL]`，并增加对应 `tests/api-deployment-boundary.test.mjs` 边界测试。最终 Compose 展开模型中 Web/API/Worker 均为 non-root Dockerfile user、`no-new-privileges`、`cap_drop=ALL`、read-only、`/tmp` tmpfs；定向测试 16/16 通过，既有 API/Worker 边界未回退。
2. 全本地 TLS/DNS mock 下，未增加 `OSS_ENDPOINT`、未修改生产代码，Web 通过真实 `ali-oss@6.23.0` production health 路径访问 OSS 风格 FQDN；临时 CA 正常校验证书 SAN，SDK 发出 `GET /?bucketInfo=` 后 `/api/health` 为 200，三项检查均为 `ok`。停止本地 OSS backend、保留同一 FQDN TLS gateway 防止外网回落后，SDK 获得本地 502，Web health 正确返回 503，响应不包含 AK、SK、FQDN、request id 或错误细节。

因此当前 Scope A 代码验收为 GO。真实阿里云 OSS/RAM Role、RDS TLS、外部 provider、Nginx/DNS/ECS 路径和人工角色 UAT 仍是发布时外部门禁；本结论不代表已经完成生产部署或生产 UAT。

## 2. 验收基线与环境

| 项目 | 结果 |
|---|---|
| 仓库 | `codex-software` 隔离 worktree |
| worktree | `C:\Users\15588\.codex\worktrees\0d56\codex-software` |
| HEAD | `b15e5bdee98230796ba7d42fe35f24dcce057ba5` |
| 父链 | `b15e5bd` → `f38ffab`（原 docs-only NO-GO）→ `9e2a8f7`（原实现基线） |
| 工作状态（验收前） | detached HEAD、clean |
| 唯一写者核对 | 无本 worktree 相关进程、无 `.lock`；主工作树位于 `D:\Dev`，不在本隔离目录写入 |
| OS / Shell | Windows / PowerShell；bash `5.0.17` 用于脚本语法检查 |
| Node / pnpm | Node `v24.19.0`；pnpm `11.9.0`；满足 `node >=22.13.0` |
| Docker | Server `29.6.2` |
| MySQL | `mysql:8.4`，实际版本 `8.4.11`，`REPEATABLE-READ` |
| 对比基准 | 原全量证据基线为 `9e2a8f7`；差量实现 `b15e5bd` 相对 `f38ffab` 仅修改 Compose 与对应边界测试两文件 |

验收前已完整阅读 `docs/refactor` 下与目标架构、实施计划、逐提交审查、Stage 6 closure 直接相关的文档，包括 00–05、implementation notes、overall audit、27 份逐提交 review、3 份 segment review、Stage 1–6 notes 与完整 Stage 5 计划。结论以当前 HEAD 为准；后续提交已经修复的旧 finding 不机械重复。

## 3. “文档要求 → 当前实现 → 权威证据 → 结论”矩阵

| 文档/硬门禁要求 | 当前实现 | 权威证据 | 结论 |
|---|---|---|---|
| 旧业务 GET 独立实现 `18 → 0` | 18 个旧业务 GET 均改为共享退役边界，API 成为唯一业务读入口 | `apps/api/test/legacy-get-boundary.test.mjs`；`pnpm test:api` 全套通过；逐个旧路由源码检查 | PASS |
| 命令安全核心 `3 → 1`；三 executor/adapter 非空 LOC ≤ 400 且净下降 | 平台内核 308、R2 adapter 41、R3 adapter 48，合计 397；相对 `fa2581c` 的 597 减少 200 | `command-executor-parity.test.mjs`；源码非空行计数；`git diff --numstat fa2581c..HEAD` | PASS |
| deploy 默认批量激活 `31 → 0` | 普通 deploy 不调用 fence 激活；激活仅由显式脚本和非空 allowlist 驱动 | `deploy/aliyun/deploy.sh`、`scripts/activate-writers.sh`、`scripts/set-writer-fences.mjs`；部署安全单测与真实 MySQL integration | PASS |
| 无新增运行组件/生产依赖；R2/R3 命名不增长；无 Scope B | closure 未修改 package/lock、三 Dockerfile 或 Compose；R2/R3 文件集合不增长；未发现 Scope B 新模型/状态机 | `git diff --name-status fa2581c..HEAD -- package.json pnpm-lock.yaml ...` 为空；R2/R3 路径集合对比；Scope B 关键词与 diff 审查 | PASS |
| Web/Fastify API/Worker 独立；同域 `/api/v1` | 三个独立镜像/进程；Nginx 把 `/api/v1/` 转发至 3001，其余到 Web 3000，并清空外部身份头 | 三镜像 build/run；`nginx-scm.conf`；API deployment boundary tests | PASS |
| session/RBAC/data-scope、CSRF/Origin、Step-up 对权威对象版本绑定；负向权限；scope-before-LIMIT | Fastify runtime 统一执行安全边界；角色和 scope 在 SQL LIMIT 前约束 | API 239 tests；真实 MySQL platform/R2/R3 integrations；角色矩阵 tests；源码 SQL 审查 | PASS |
| 文件 quarantine/scan；事务/锁/CAS、幂等、writer fence、audit/outbox | 文件先 quarantine，Worker scan 后推进；命令统一内核具备事务、锁、idempotency digest、fence、audit/outbox | API/Worker tests；真实 MySQL platform/R2/R3/Worker integrations | PASS |
| canonical `0000–0004` SQL/snapshot/journal 冻结一致 | 单一 canonical manifest 校验 5 个 migration、snapshot、journal hash/metadata | repository validator：`validated 5`；migration-history tests | PASS |
| fresh、canonical partial upgrade/repeat；unknown hash/gap/dirty/future fail closed | fresh 和 `0000–0001` partial 均升级到 5/5 且 repeat；四种破坏历史均 exit 1 | 独立 MySQL 数据库实际执行，见第 5 节 | PASS |
| 同 key replay、异 digest 拒绝、并发单执行、unknown outcome、回滚、审批/库存/财务守恒、fence、lease/outbox/domain event | 平台、R2、R3 与 Worker 均以真实 MySQL 覆盖 | API MySQL 11/11；Worker 4/4；payment row-lock 1/1；deployment MySQL 5/5 | PASS |
| 普通 deploy fence 零变化；空 allowlist fail closed；partial activation 只改目标；未激活时健康但副作用暂停 | 显式激活事务化、可重复、按资源；Worker disabled fence 保持 ready 并暂停消费 | deployment MySQL 5/5；Worker MySQL 4/4；手工 runtime 中 Worker disabled 且 ready 200 | PASS |
| manifest 与 5 migrations/35 commands/29 resources 一致；rollback generation 安全 | release manifest 由 canonical 集合生成；pre-Scope-A/跨 generation 拒绝，同 generation exact contract 才允许 | release-deployment-safety tests；真实 deployment integration；源码审查 | PASS |
| clean frozen install、TS/tests/build/audit/diff-check；区分 changed/global lint 基线 | install、TS、API/Worker/legacy tests、Aliyun build、audit、diff-check 通过；changed lint 0 errors/94 warnings，global lint 28 errors/116 warnings，28 errors 与 Stage 1 记录基线一致 | 第 6 节命令结果 | PASS（lint 债务保留，不将 warning 声称为清零） |
| API/Worker/Web Docker build/runtime：non-root、read-only、cap-drop、health、request-id、生产闭包 | 三镜像均构建；user 为 `api`/`worker`/`nextjs`；最终 Compose 对三者均强制 no-new-privileges、`cap_drop=ALL`、read-only、`/tmp` tmpfs；API/Worker 既有 health 与 request-id 证据保持；Web 真实 ali-oss SDK 本地 TLS 正向 200、backend 停止后脱敏 503 | 原三镜像 build/run/inspect；`b15e5bd` 定向边界测试 16/16；Compose JSON 展开；本地 TLS/DNS OSS mock health 正负请求 | PASS |
| UAT 使用真实 Fastify inject/现有角色矩阵，不虚构人工生产 UAT | internal/factory/supplier_qc/receiver/finance 等正负权限、scope、preview/production fail-closed 由自动化覆盖；未执行人工生产 UAT | API 239 tests 和 MySQL platform integration | 自动化部分 PASS；人工/环境项待发布前完成 |

## 4. 结构与 LOC 量化

### 4.1 旧读和命令内核

| 指标 | `fa2581c` | 当前 HEAD | 结果 |
|---|---:|---:|---|
| 旧业务 GET 独立实现 | 18 | 0 | 达标 |
| 命令安全核心 | 3 | 1 | 达标 |
| `apps/api/src/platform/commands.ts` 非空 LOC | 283 | 308 | 共享核心承接共性逻辑 |
| R2 `command.ts` 非空 LOC | 167 | 41 | -126 |
| R3 `command.ts` 非空 LOC | 147 | 48 | -99 |
| 三文件合计非空 LOC | 597 | 397 | -200，且 ≤ 400 |
| 普通 deploy 激活资源数 | 31 | 0 | 达标 |

`command-executor-parity.test.mjs` 证明 platform/R2/R3 走同一 idempotent command state machine，而不是仅通过文本合并伪造 `3 → 1`。

### 4.2 组件、依赖和 Scope B

- `fa2581c..9e2a8f7` 没有修改 `package.json`、`pnpm-lock.yaml`、API/Worker package、三份 Dockerfile或 `deploy/aliyun/docker-compose.yml`，因此原 closure 没有新增运行组件或生产依赖。差量 `b15e5bd` 只修改 Compose 的 Web capability drop 与对应边界测试，不增加组件或依赖。
- R2/R3 既有路径集合和 writer identity 集合未增长。release manifest 中 R2/R3 文本计数增加来自把既有 35 commands / 29 resources 集中为 canonical manifest，不是新增阶段/模块。
- 未实现 PurchaseReceipt/采购收货入库、BOM 真实库存预留/领料/消耗、质检后库存放行/隔离、Receiver/LegalEntity 模型、真实银行指令或新业务状态机。

## 5. 真实 MySQL 8 / 写并发证据

所有本地数据库均位于容器 `codex-scopea-wave4-acceptance-mysql`，数据库名均以 `codex-scopea-wave4-acceptance-` 开头；测试源中原有随机库名前缀通过 **内存 loader** 临时替换，没有改写仓库文件。

### 5.1 migration

| 场景 | 结果 |
|---|---|
| fresh 空库 preflight | `0/5`，允许 |
| fresh 首次 migrate | `5/5`，PASS |
| fresh repeat migrate | 仍为 `5/5`，PASS |
| canonical partial (`0000–0001`) preflight | `2/5`，允许 |
| partial upgrade | `5/5`，PASS |
| partial repeat | `5/5`，PASS |
| unknown hash | exit 1，fail closed |
| migration gap | exit 1，fail closed |
| 非空业务库但无 history | exit 1，fail closed |
| history 含未知 future migration | exit 1，fail closed |

### 5.2 integration

| 套件 | 通过/失败/跳过 | 覆盖 |
|---|---:|---|
| API MySQL focused integrations | 11/0/0 | platform auth/OTP/CSRF/idempotency/scope/quarantine；R2；R3；事务、锁、audit/outbox、replay、fence、守恒 |
| Worker MySQL replay integration | 4/0/0 | notification replay、domain event、lease/dead-letter、disabled fence 暂停不消费 |
| Payment row-lock integration | 1/0/0 | 财务并发串行化 |
| Deployment safety MySQL integration | 5/0/0 | fresh/dirty/rollback；partial activation；disabled readiness；0004 legacy correction；canonical upgrade/repeat/divergence |

真实 deployment integration 总耗时约 234 秒；覆盖 ordinary deploy 保持 fence、空 allowlist fail closed、partial activation 只更新目标、重复激活幂等、同 generation compatibility 以及 legacy/cross-generation 拒绝。

## 6. 执行命令和结果计数

以下列出对结论有意义的完整验收命令；环境变量仅使用本地临时凭据，未读取生产凭据。

### 6.1 基线、安装、静态与全量工程门禁

```text
git rev-parse HEAD
# 9e2a8f70acebc35b6924860b9597ebe0b3421903

git status --short
# 验收前为空

corepack pnpm install --frozen-lockfile
# PASS；4 workspace projects；682 packages；0 downloads；supply-chain policy PASS

corepack pnpm test:api
# 239 pass / 0 fail / 5 skip（5 个显式 MySQL suite 后续单独实跑）

corepack pnpm test:worker
# 5 pass / 0 fail / 4 skip（MySQL suite 后续单独实跑）

corepack pnpm exec tsc --noEmit
# PASS

corepack pnpm build:aliyun
# PASS；Next 16.2.11；TypeScript PASS；47 routes

node --test tests/*.test.mjs
# 在正确的 `vinext dev` runtime 下：99 pass / 0 fail / 6 skip

node --test tests/rendered-html.test.mjs
# 4 pass / 0 fail

corepack pnpm audit --prod --audit-level=low
# PASS；no known vulnerabilities

git diff --check fa2581c..HEAD
# PASS

corepack pnpm lint
# exit 1；28 errors / 116 warnings；28 errors 与 Stage 1 文档记录的既有基线相同

corepack pnpm exec eslint <fa2581c..HEAD changed JS/TS files> --max-warnings 0
# exit 1；0 errors / 94 warnings；严格零 warning 未达成
```

说明：最初直接运行 root tests 时没有先启动服务，得到 4 个 connection-refused；随后用 `next dev` 又因该仓库实际开发 runtime 是 Vinext 而出现 Cloudflare runtime module 500。改用仓库声明的 `vinext dev` 后全套 99/0/6。前两次是验收命令选择修正，不计作产品失败，也未掩盖其原始结果。

### 6.2 migration 与真实 MySQL

```text
docker run --name codex-scopea-wave4-acceptance-mysql -p 127.0.0.1:33306:3306 ... mysql:8.4
# MySQL 8.4.11 / REPEATABLE-READ

node scripts/check-mysql-migration-history.mjs
corepack pnpm db:migrate:mysql
node scripts/check-mysql-migration-history.mjs
corepack pnpm db:migrate:mysql
# 分别对 fresh、canonical partial、unknown、gap、dirty、future 数据库执行；结果见 5.1

node --test --test-concurrency=1 apps/api/test/mysql-*.integration.test.mjs
# 11 pass / 0 fail / 0 skip

node --test apps/worker/test/mysql-worker-replay.integration.test.mjs
# 4 pass / 0 fail / 0 skip

node --test tests/mysql-payment-lock.integration.test.mjs
# 1 pass / 0 fail / 0 skip

node --experimental-loader <in-memory-prefix-loader> --test tests/mysql-deployment-safety.integration.test.mjs
# 5 pass / 0 fail / 0 skip；234s
```

`<in-memory-prefix-loader>` 只把 integration test 源码中的临时数据库前缀替换为本次批准的 `codex-scopea-wave4-acceptance-`，未创建或修改仓库文件。

### 6.3 发布脚本、Compose、镜像与 runtime

```text
bash -n deploy/aliyun/deploy.sh
bash -n deploy/aliyun/rollback.sh
bash -n scripts/activate-writers.sh
# 全部 exit 0

docker compose --env-file deploy/aliyun/.env.production.template \
  -f deploy/aliyun/docker-compose.yml config --no-interpolate
# 原 `9e2a8f7` 验收时 exit 0，曾显示 API/Worker 有 cap_drop=ALL、app 缺失；
# `b15e5bd` 差量复验后的最终展开见 6.4，三服务现均为 ALL

docker build -f Dockerfile.api --target runner \
  -t codex-scopea-wave4-acceptance-api:9e2a8f70 .
docker build -f Dockerfile.worker --target runner \
  -t codex-scopea-wave4-acceptance-worker:9e2a8f70 .
docker build -f Dockerfile.aliyun --target runner \
  -t codex-scopea-wave4-acceptance-web:9e2a8f70 .
# 三个 build 均 PASS

docker run ... --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --name codex-scopea-wave4-acceptance-{api,worker,web}-runtime ...
# 三镜像均能以约束启动；inspect 见下表
```

| 容器 | User | read-only | cap-drop | health |
|---|---|---:|---|---|
| API | `api` (uid 1001) | true | ALL | live 200；ready 200 |
| Worker | `worker` (uid 1001) | true | ALL | live 200；ready 200（fence disabled） |
| Web | `nextjs` (uid 1001) | true | ALL；`b15e5bd` 后也由 Compose 强制 | 原验收无 OSS 环境为 503；差量本地 TLS/ali-oss 正向 200、停 backend 后脱敏 503 |

API 对 `x-request-id: scopea-acceptance-request-001` 的 404 响应返回相同 header，并在 JSON body 中返回同一 requestId。生产闭包抽查：API 镜像含 Fastify/mysql2、不含 Next；Worker 含 mysql2、不含 Fastify/Next；Web standalone 含 Next、不含 API/Worker 源目录。三容器 `/app` 写探针均因 read-only filesystem 失败。

### 6.4 `b15e5bd` 极窄差量复验

```text
git rev-parse HEAD
# b15e5bdee98230796ba7d42fe35f24dcce057ba5

git rev-parse HEAD^
# f38ffab0fa9c4959b6f503f9e78733812a866000

git diff --name-status f38ffab..b15e5bd
# M deploy/aliyun/docker-compose.yml
# M tests/api-deployment-boundary.test.mjs

node --test tests/api-deployment-boundary.test.mjs
# 16 pass / 0 fail / 0 skip

bash -n deploy/aliyun/deploy.sh
bash -n deploy/aliyun/rollback.sh
bash -n scripts/activate-writers.sh
# 三者 exit 0

docker compose --env-file deploy/aliyun/.env.production.template \
  -f deploy/aliyun/docker-compose.yml config --no-interpolate --format json
# exit 0；app/api/worker 均展开为 no-new-privileges、cap_drop=ALL、read_only=true、/tmp tmpfs；
# 三者均只发布到 127.0.0.1；Dockerfile USER 分别为 nextjs/api/worker

docker build -f Dockerfile.aliyun --target runner \
  -t codex-scopea-wave4-revalidation-web:b15e5bd .
# PASS；Next 16.2.11；TypeScript PASS；47 routes
```

本地 OSS SDK production health 验证拓扑：

```text
Web (nextjs, read-only, cap-drop ALL)
  -> TLS/DNS gateway alias:
     codex-scopea-wave4-revalidation-bucket.oss-cn-hangzhou.aliyuncs.com:443
  -> local OSS backend:8080

MySQL: mysql:8.4，位于同一独立 Docker network
TLS: 临时 CA；server SAN 覆盖 bucket FQDN 与 OSS endpoint FQDN
Web env: 临时 AK/SK、OSS_INTERNAL_ENDPOINT=false、NODE_EXTRA_CA_CERTS=<临时 CA>
生产代码: 未新增 OSS_ENDPOINT，未修改
```

正向证据：

```text
ali-oss user-agent: aliyun-sdk-nodejs/6.23.0 Node.js 22.23.2 on Linux 64-bit
request: GET /?bucketInfo= HTTP/1.1
Web /api/health: 200
{"status":"ok","runtime":"aliyun","checks":{"application":"ok","database":"ok","objectStorage":"ok"},...}
```

负向证据：停止本地 OSS backend，但保留同一 FQDN TLS gateway，使 DNS 不可能回落到公网；gateway 本地记录 ali-oss 请求为 502。Web `/api/health` 返回 503，body 仅含 `application=ok`、`database=ok`、`objectStorage=failed`。检查确认 body 不含临时 AK、SK、`aliyuncs.com`、mock request id、主机/连接/证书/stack/message/upstream 等错误细节。

执行透明度说明：最初探索使用单容器同时承担 FQDN alias 和 OSS 响应；停止该容器后 Docker alias 随之消失，一次使用纯临时假 AK/SK 的探针意外解析到公网 OSS 并得到 `NoSuchBucket`，该结果立即作废且未作为验收证据。随后改为“常驻本地 TLS/DNS gateway + 可停止 backend”的两层模型，以上最终正负证据均来自该全本地模型；未使用生产凭据、未传输业务数据、未做部署。

## 7. 发布/回滚和 Nginx 边界

- `deploy.sh` 负责 build、manifest、环境/历史检查、stop/drain/migrate/start/probe，不包含 writer activation。
- `activate-writers.sh` 要求非空资源 allowlist、release/generation/contract 对齐、drain=0、reconciliation hash/diff=0、approval/reason、observability 与 live drain；事务只锁定目标资源并支持幂等。
- `rollback.sh` 要求 current/target release manifest、镜像事实与 DB facts/fences 一致；pre-Scope-A、跨 generation/schema/contract rollback 均拒绝；同 generation exact compatibility 才允许。
- Nginx 仅在同域把 `/api/v1/` 发给独立 API，并设置 `X-Request-ID`、`X-Forwarded-*`，清空所有外部 `oai-authenticated-user-*` 身份头；Web 路由保持在 3000。
- Compose 端口只绑定 `127.0.0.1`；Web/API/Worker 均为 non-root Dockerfile user、read-only、cap-drop ALL、no-new-privileges 和独立 `/tmp` tmpfs。原 Web capability Important finding 已由 `b15e5bd` 关闭。

## 8. UAT 证据边界

已自动证明：

- 真实 Fastify inject 角色矩阵覆盖 internal、factory、supplier_qc、receiver、finance 等角色的正向与负向授权。
- 覆盖 entity/data scope、scope-before-LIMIT、越权返回、CSRF/Origin、Step-up、preview/production fail-closed。
- 真实 MySQL platform integration 覆盖 session、OTP、scope、quarantine 和幂等。

未执行、也不声称执行：

- 人工生产 UAT；
- 真实阿里云 OSS/RAM Role、RDS TLS、短信/邮件/扫描供应商的生产连通性；
- 真实 Nginx TLS 证书、DNS、ECS/SLB 路径；
- 实际发布窗口中的 observability、drain/reconciliation/approval evidence。

这些必须作为发布前人工/环境门禁，但不是当前 Scope A 代码阻断。差量复验已经证明 Web production health 代码路径在真实 ali-oss SDK、正常 TLS 校验、本地 MySQL 和全本地 DNS/网络 mock 下可以 200，并在 OSS backend 失败时正确、脱敏地 503；这不替代真实云环境门禁。

## 9. 旧 review finding 的最终状态

| 旧 finding（以 `fa2581c` overall audit 为起点） | 后续修复 | 当前状态 |
|---|---|---|
| 18 个旧业务 GET 保留独立实现 | `c794c1` | 已关闭；18→0 |
| 历史 migration 被改写/缺 canonical 冻结 | `e83b656` | 已关闭；0000–0004 SQL/snapshot/journal 一致，真实 fresh/partial/repeat 通过 |
| 普通 deploy 批量激活 31 个 writer | `6fa2924` | 已关闭；普通 deploy 31→0，显式 allowlist 激活 |
| rollback 未核对 R2/R3 release facts/generation | `6fa2924` | 已关闭；同 generation exact contract 才允许 |
| 平台/R2/R3 三套命令执行器重复 | `9e2a8f7` | 已关闭；3→1，总非空 LOC 597→397 |
| Receiver/LegalEntity 等模型只具条件性边界 | 未在 Scope A 实现 | 正确保留为 Scope B 排除项，不误报为 Scope A 完成 |
| Web production Compose 缺 `cap_drop` | `b15e5bd` | 已关闭；最终 Compose 展开为 `cap_drop=ALL`，定向边界测试 16/16 |

## 10. Scope B 排除项

本次没有实现、修改或以“验收通过”暗示以下能力：

- PurchaseReceipt / 采购收货入库；
- BOM 真实库存预留、领料、消耗；
- 质检后真实库存放行/隔离；
- Receiver / LegalEntity 模型；
- 真实银行指令；
- 新业务状态机。

## 11. 资源清理

已删除且不可恢复的仅为本次创建的临时测试资源：

- 容器：`codex-scopea-wave4-acceptance-mysql`、API/Worker/Web runtime 共 4 个；
- 镜像 tag：API、Worker、Web 共 3 个；
- 本地 provider mock 进程及监听端口；
- MySQL 容器内所有 fresh/partial/failure-path 临时数据库随容器删除。

最终核对：前缀 `codex-scopea-wave4-acceptance-` 的 containers/images/volumes/networks 均为 `0`；端口 `33306`、`33307`、`33000`、`33001`、`33002` 均不再监听。未删除任何未知 Docker 资源。

差量复验仅创建 `codex-scopea-wave4-revalidation-*` 前缀资源：Web、MySQL、TLS gateway、OSS backend 四个容器，一个 Web image tag，一个独立 network，以及同前缀的临时证书/CA/配置文件。正向、负向路径结束后全部删除；最终 containers/images/volumes/networks 均为 `0`，临时文件为 `0`，本地端口 `33100` 不再监听。未删除共享基础镜像或任何未知资源。

## 12. 停止说明

`b15e5bd` 的极窄差量已关闭原两个代码验收阻断点，最终结论为 **GO**。本验收任务没有修改生产实现、测试、配置、脚本、package、lock、migration 或业务逻辑；唯一仓库写入是更新本报告。没有 push、merge、deploy，没有使用生产凭据，也没有实现 Scope B。发布团队仍须在受控环境完成真实阿里云 OSS/RAM Role、RDS TLS、外部 provider、Nginx/DNS/ECS/SLB、observability/drain/reconciliation/approval evidence 和人工角色 UAT，方可发布。
