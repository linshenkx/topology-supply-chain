# Stage 7 工程规范化债务与目标结构审计

> 审计基线：`6287c8b4d1b6517cd739c7c7553868079ff5994e`（`main` / `origin/main`）
>
> 审计日期：2026-08-12（Asia/Shanghai）
>
> 本文性质：只读审计与后续实施计划；不修改业务、源码、配置、依赖、迁移或资产
> 范围：Scope A 工程规范化；明确排除 Scope B

## 1. 结论先行

当前工程已经实现了**运行意义上的前后端分离**：Web、Fastify API、后台 Worker 分别具备独立 package、构建命令、镜像、端口、健康检查和 Nginx 路由所有权。它仍处于**过渡型 monorepo**：Web 位于根 `app/`，API/Worker 位于 `apps/`，契约位于 `packages/contracts/`，旧 Next API 与根数据库层仍作为退役/兼容边界存在。

这两个判断不冲突。前后端分离回答的是“源码依赖、进程、契约、权限、发布和数据所有权是否分开”；monorepo / multi-repo 回答的是“这些运行单元是否共用 Git、lockfile、CI 与变更原子性”。它们是独立维度。

本轮最重要的工程判断如下：

1. **当前不应仅为目录整齐拆成多个仓库。** 单 Git、单 lockfile、`workspace:*` contracts、共享 migration/release manifest、writer fence、Compose 和跨服务测试都证明三运行时仍需要高频原子协作。拆仓会先制造 contracts 发布、版本兼容、跨仓 CI 和回滚协调成本。
2. **也不应立即把根 `app/` 机械搬到 `apps/web/`。** 运行边界已经成立；目录移动会触及 Next/Vinext、Docker context、路径别名、根 package、D1/Sites 预览和发布脚本。应先把文档、门禁、生成物边界、命名冲突和超大模块等高收益债务收口，再单独验证是否移动。
3. **根目录混乱是真问题，但不能靠删除原始资产解决。** 80 个一级条目中，40 个含 tracked 内容、39 个为 ignored、1 个为 `.git`。29 个根级 tar 全部早于 Git 初始基线，属于功能交付/热修历史快照；本次审计不移动，后续经 manifest、敏感扫描、hash 与恢复验证后迁入项目根 `archive/legacy-deliveries/`。
4. **代码质量债务集中而可分批处理。** 四套 TypeScript 检查均通过；ESLint 基线为 28 errors / 117 warnings，主要集中在 Web Hooks、类型声明和未使用变量，同时 lint 配置误扫 `apps/api/dist` 与 `.tmp`。应先修工具边界，再修真实告警，不能混批。
5. **复杂度上升的一部分是必须保留的安全成本。** Session/RBAC/data-scope、CSRF/Origin、Step-up、事务/锁/CAS、幂等、writer fence、audit/outbox、文件 quarantine/scan 和 scope-before-LIMIT 不能为降 LOC 删除。
6. **目标不是套用空壳“最佳实践”目录。** 没有证据支持新增 CQRS、事件溯源、微服务、空 repository/service/domain 层、共享大包或新生产依赖。目录只在存在明确所有权和复用证据时创建。

## 2. 审计方法、基线和限制

### 2.1 基线门禁

- CWD：`D:\Dev\myProject\codex-software`
- 分支：`main`
- HEAD 与 `origin/main`：均为 `6287c8b4d1b6517cd739c7c7553868079ff5994e`
- 工作树：审计开始时 clean
- worktree：仅主 checkout
- 初始 Git 提交：`607cb1caac8ccfdf085795057f9bd5737f021eae`，2026-08-11，`chore: establish initial project baseline`

### 2.2 使用的证据

- Git：tracked/ignored、首次加入提交、当前引用、提交历史。
- 文件系统：一级目录 100% 枚举、大小、mtime、生成物/本地资产分类。
- tar：只读成员清单、类型、SHA-256、成员与当前路径逐字节比较；未解压到项目。
- 工具基线：根/API/Worker/Contracts 四套 TypeScript；全仓 ESLint JSON 统计。
- 文档对照：`docs/refactor/00-overview.md`、`02-target-architecture.md`、Stage 6 验收和逐提交审查。
- 依赖/发布：workspace、四个 importer、三 Dockerfile、Compose、Nginx、migration 与 release scripts。

### 2.3 限制

- 本文不读取或输出真实密钥，不连接生产环境，不判断 ignored 资产的法定保留期。
- tar 内容只做路径、类型与字节比较，未逐文件做敏感信息扫描；后续迁入项目内 `archive/` 前必须在受控流程中补做。
- LOC 是物理行数信号，不等同于认知复杂度；生成 schema、JSON snapshot 和测试数据会放大行数。
- 本文不执行后续波次，也不授权移动、重命名或删除任何资产。

## 3. 前后端分离与单仓/多仓取舍

### 3.1 当前已经分离到什么程度

| 维度 | 当前证据 | 判断 |
| --- | --- | --- |
| 进程 | Web 3000、API 3001、Worker 3002，各自启动与健康检查 | 已分离 |
| 镜像 | `Dockerfile.aliyun`、`Dockerfile.api`、`Dockerfile.worker` | 已分离 |
| 路由 | Nginx `/api/v1/*` 到 Fastify，其余到 Web | 已分离 |
| 契约 | `packages/contracts` 由 API 使用；Web 仍以手写 helper/DTO 为主 | 部分完成 |
| 数据所有权 | API/Worker 使用 MySQL；根 Next DB 仍服务 legacy/平台兼容代码 | 过渡态 |
| 发布 | Compose/manifest 协调三服务；可分别构建但仍需联合兼容门禁 | 独立运行、协同发布 |
| 源码目录 | 根 `app/` + `apps/api` + `apps/worker` | 非对称但有效 |

因此，“没有 `apps/web/`”不能推出“没有前后端分离”；真正未完全收口的是依赖和兼容实现，而不是目录名字。

### 3.2 三种仓库模式比较

| 维度 | 单仓多应用（当前方向） | Web/API/Worker 多仓 | 混合模式（核心同仓，独立适配器/SDK 分仓） |
| --- | --- | --- | --- |
| 独立构建部署 | 可用 package filter/镜像实现；需严格 CI matrix | 天然独立 | 取决于切分边界 |
| 权限隔离 | Git 仓权限较粗，可用 CODEOWNERS/CI 补强 | 最强 | 对高敏仓可强化 |
| contracts | `workspace:*` 原子更新，简单 | 必须发布版本、维护兼容窗口 | 核心 contracts 可发布，内部仍原子 |
| migration/writer identity | 可与应用同提交审查 | 跨仓协调最困难 | 数据所有权仓必须唯一 |
| CI | 单次变更可做受影响矩阵；配置更复杂 | 每仓简单，但端到端需编排 | 两者并存 |
| 回滚兼容 | manifest 可引用同一 SHA | 必须处理多个仓库/制品版本组合 | 需要统一 release BOM |
| 团队协作 | 适合当前小团队和大规模重构期 | 适合稳定、独立团队与发布节奏 | 适合少数强隔离边界 |
| 迁移成本 | 最低 | 最高：历史、issue、CI、包发布、权限均拆分 | 中等 |

### 3.3 当前推荐

**保留 monorepo，多应用、多镜像、多运行时；先规范边界，不拆仓。** 证据是：

- 单 `.git`、单 `pnpm-lock.yaml`、四个 workspace importer。
- API 直接依赖 `@topology/contracts` 的 workspace 版本。
- 三 Docker build 均以仓库根为 context。
- migration、release manifest、writer fence、Compose 和回滚协议跨服务耦合。
- 根测试直接审查 API、Worker、Dockerfile、Compose 和 migration。

未来只有同时满足以下任一类事实，才值得重新裁决 multi-repo：

- Web/API/Worker 已由不同团队独立负责，权限和发布节奏长期不同；
- contracts 已有稳定版本策略、兼容窗口和制品仓；
- migration 与数据库所有权已归属唯一后端仓，跨仓端到端门禁可重复；
- 安全/合规要求代码访问物理隔离。

## 4. 当前规模与质量基线

### 4.1 文件与 LOC

统计只包含 `git ls-files` 返回的 381 个 tracked 文件；ignored/untracked 生成物与本地资产不计入源码规模。

| 分类 | 文件 | 物理行数 | 说明 |
| --- | ---: | ---: | --- |
| 生产源码 | 179 | 35,065 | Web、API/Worker/Contracts src、DB、edge worker、build plugin |
| 测试与 test helper | 62 | 15,820 | 根/API/Worker tests |
| 文档 | 57 | 5,790 | tracked Markdown；其中 `docs/` 46 文件 |
| 迁移与生成物 | 23 | 62,750 | SQL 2,785；Drizzle meta JSON 58,702；生成 MySQL schema 1,263 |
| scripts 与 deploy | 28 | 1,890 | scripts、deploy、Dockerfile |
| examples | 2 | 67 | D1 notes 示例 |
| 配置及其他文本 | 23 | 523 | package/TS/ESLint/Vite 等 |
| lock/vendor/assets | 7 | 8,244 | lock 文本加二进制资产 |

排除生成 MySQL schema 后，手写生产代码为 173 文件、34,511 LOC。Top 5 占 16.8%，Top 10 占 27.1%，Top 20 占 43.8%；23 个手写生产文件不少于 500 LOC，6 个不少于 800 LOC，3 个不少于 1,000 LOC。最大文件包括：

| 文件 | 行数 | 风险 |
| --- | ---: | --- |
| `apps/api/src/modules/suppliers/index.ts` | 1,840 | 多查询/映射/权限集中，变更审查面过大 |
| `db/schema.ts` | 1,255 | 单一 schema 事实源过大但拆分涉及生成/迁移 |
| `apps/api/src/infrastructure/database.ts` | 1,006 | pool、deadline、transaction、错误边界集中 |
| `apps/api/src/modules/auth/writes.ts` | 847 | 高风险身份写路径 |
| `apps/api/src/modules/production-orders/index.ts` | 844 | 查询与 DTO 集中 |
| `app/page.tsx` | 819 | 导航/状态/模块装配集中 |
| `apps/worker/src/server.ts` | 742 | claim/provider/retry/health 集中 |

### 4.2 TypeScript 与 ESLint

- 根、API、Worker、Contracts 四套 `tsc --noEmit --incremental false` 均通过。
- 全仓 ESLint：28 errors / 117 warnings。

| 顶层 | errors | warnings | 主要原因 |
| --- | ---: | ---: | --- |
| `app` | 23 | 111 | 16 个 `set-state-in-effect`、6 个 unsafe Function、5 个 any（部分在其他顶层）、106 个 unused vars、8 个 deps |
| `types` | 3 | 0 | Cloudflare ambient `any` |
| `apps` | 1 | 3 | `apps/api/dist/*.d.ts` 被误扫 + parser warning |
| `tests` | 1 | 0 | Next 规则误用于 Node test |
| `db` | 0 | 2 | parser/config |
| `.tmp` | 0 | 1 | 本地临时文件被误扫 |

必须先修 lint 范围：忽略所有 package `dist`、`.tmp`、本地缓存，并按 Web/Node/tests/types 分 override；随后才把剩余告警设为真实基线。否则“修 28 个错误”会混入生成物和错误规则。

### 4.3 阶段命名、legacy 与重复

- 广义检索显示 R2 相关文件 34 个、R3 相关文件 32 个（排除 `dist`）；其中一部分是持久化 command/resource identity 和测试，不能直接改名。
- 32 个 Next route 文件引用统一 `retiredPlatformRoute`，总计约 2,977 LOC；18 个旧业务 GET 已在 Stage 6 收口为无独立 DB/授权实现的 410 边界。10 个文件仍以恒真 `request.method.length >= 0` 先返回 410，之后保留约 2,746 LOC 不可达旧主体；其中 finance 636、approvals 556、shipments 530 LOC。兼容行为应保留，旧主体是否删除仍需回滚策略裁决。
- 根 `app/lib` 与少数旧 Next route 仍导入根 `db`；应区分“必要平台兼容/预览”与“可删除业务实现”，不能按路径批删。
- 目录依赖存在明确反向边：Legacy Next → 根 DB 43 条；根 DB 又有 4 条导入 `app/lib/runtime-env` 或 `app/lib/business-rules`，形成 `app ↔ db` 目录级潜在循环。Fastify → contracts 约 30 条，contracts 无反向 import；Worker 也不导入 Web/API/contracts，新的运行边界本身是清晰的。
- command executor 已在 Stage 6 从三套核心收敛为一个平台内核 + R2/R3 薄 adapter；不应重复发起同一重构。
- `packages/contracts` 当前主要被 API 使用，Web/Worker 尚未形成统一契约消费；“contracts 已共享”需准确表述为“已建立事实源，但消费尚未完全统一”。
- 高置信重复包括：Web 与 contracts 各有一份完整 R2 mutation mapping；canonical digest 有 3 份完全同体实现；18 个模块重复 no-store hook；`DataRow` 在 19 个文件定义；若干 validator/placeholder 完全或近似重复。只应先抽取完全相同、无领域语义且有 golden tests 的 primitive。
- `app/page.tsx` 有 6 个未使用 panel 函数；大量 legacy unused imports 解释了 102+ 个真实源码 unused warnings。确定 dead code 的删除也必须与 Hooks 行为修复分批。

### 4.4 测试、fixture 与生成产物耦合

- 61 个 `*.test.mjs`，约 351 个 `test()`：API 普通 38 文件/239 tests、API MySQL integration 5/11、Worker 普通 2/5、Worker integration 1/4、根普通 13/86、根 integration 2/6。
- 8 个 MySQL integration 文件依赖环境变量，可在无数据库时 skip；后续 CI 必须把“允许 skip 的普通 PR”与“发布候选必须执行的 MySQL 门禁”分开。
- 23/61 测试读取源码或部署文本做静态安全断言。这对 writer fence、legacy 410、Docker 边界有价值，但会提高目录移动/格式化耦合，因此机械移动必须单独更新测试，不能顺便改 expectation。
- 41/61 测试从已构建 `dist` 导入，说明 test 与 build 有明确顺序依赖；统一 verify 命令必须先构建 contracts/API/Worker。
- 没有通用 fixture 目录；大量 fixture 内联，仅存在 `xlsx-test-helpers.mjs` 等局部 helper。当前没有证据支持先创建 `test-support` 包，应在两个以上 package 出现完全相同 fixture 生命周期后再抽取。
- ignored 产物包括 `.next` 约 43.1 MB、根 `dist` 约 8.8 MB、API/Contracts dist、本地 `outputs` 约 13.7 MB。它们解释了 lint/扫描污染，但 ignored 不代表可删除。

### 4.5 构建、环境与发布配置

- 根 `.env.example` 24 个变量、生产模板 37 个、Compose 引用 31 个；另有 transaction timeout、worker pool、image tags 等默认/发布参数未形成单一契约。
- 四套 tsconfig 的 runtime 目标差异合理，但 root `**/*.ts(x)` 会覆盖整个 monorepo；根缺少 API/Contracts 已启用的 `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`，不能假定“strict”完全等价。
- 三套 DB 连接/池/TLS 默认分布在根 Next、Fastify、Worker；合并生命周期会有 unknown-outcome 风险，近期只应统一可证明的配置解析与测试向量。
- 三 Dockerfile 共享根 context；API/Worker 构建会看到根 vendor，Worker 也复制自身不消费的 xlsx tar。应先通过 `.dockerignore` 和生产 closure 证据收窄，不急于引入复杂 base image。
- `.github` 无 workflow；`CONTRIBUTING.md` 最小命令未覆盖 API 43 个、Worker 3 个（合计 46 个）`*.test.mjs`。当前 Stage 6 文档保存了完整门禁证据，但仓库没有自动机制保证后续提交重复执行。

### 4.6 当前可复现门禁状态

| 门禁 | 本审计证据 | 状态 |
| --- | --- | --- |
| 根 TypeScript | `tsc --noEmit --incremental false` | PASS |
| API TypeScript | `tsc -p apps/api/tsconfig.json --noEmit --incremental false` | PASS |
| Worker TypeScript | `tsc -p apps/worker/tsconfig.json --noEmit --incremental false` | PASS |
| Contracts TypeScript | `tsc -p packages/contracts/tsconfig.json --noEmit --incremental false` | PASS |
| ESLint | 全仓配置口径 28 errors / 117 warnings | FAIL，基线已量化 |
| tests/build/Docker/MySQL | Stage 6 验收报告记录完整 PASS；本任务为只读文档审计，未重跑会生成产物或启动容器的门禁 | 需由 Wave 1 自动化复现 |

“可复现基线”不等于假装当前 lint 为绿；准确结论是 TypeScript 当前可复现通过、lint 当前可复现失败、其余完整门禁只有 Stage 6 证据而缺持续 CI。

## 5. 根目录 100% 台账

### 5.1 非 tar 的 51 个条目

| 条目 | 分类/来源 | 用途与引用 | 是否应在根 / 未来位置 | 风险与裁决 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| `.dockerignore` | tracked / 初始基线 | 三 Docker context 过滤 | 应在根；补全规则另批 | 未忽略 tar/store/tsbuildinfo | 高 |
| `.env.example` | tracked / 初始 | 本地配置示例 | 根保留；未来拆分 `env/*.example` 需验证 | 与生产模板覆盖不一致 | 高 |
| `.git` | VCS | 单仓元数据 | 根保留 | 禁止人工清理 | 高 |
| `.github` | tracked / 初始 | PR 模板；无 workflow | 根保留 | 缺自动 CI | 高 |
| `.gitignore` | tracked / 初始 | 忽略依赖/缓存/压缩包 | 根保留 | `/build/` 与真实源码冲突 | 高 |
| `.next` | ignored/generated | Next 缓存，约 43.1 MB | 当前保留；可再生 | 不得与历史资产一并清理 | 高 |
| `.openai` | tracked / 初始 | Sites/D1/R2 hosting 配置 | 支持预览时留根；否则待裁决 | 是否仍为正式平台未知 | 高 |
| `.pnpm-store` | ignored/generated | 本地 pnpm store | 当前保留；可再生 | 非源码 | 高 |
| `.tmp` | ignored/local | 日志和阶段 notes，约 0.57 MB | 本次不移动；有价值项未来归入 `archive/working-notes/` | 含审计记录，不能直接删；纯临时项也需逐项裁决 | 高 |
| `.wrangler` | ignored/generated/local | Wrangler/Miniflare 状态 | 支持预览时合理 | 本地状态非交付物 | 高 |
| `app` | tracked / 初始 | Next Web、bridge、legacy 边界 | 现阶段合理；可选未来 `apps/web` | 搬移影响面大 | 高 |
| `apps` | tracked / API runtime | Fastify API、Node Worker | 合理 | 与根 Web 非对称是过渡债务 | 高 |
| `build` | tracked / 初始 | Sites Vite plugin 源码 | 不宜叫 generated build；未来可改 `tooling/sites` | 被 `.gitignore` 忽略新文件 | 高 |
| `CONTRIBUTING.md` | tracked / 初始 | 协作指南 | 根合理 | 门禁未覆盖 API/Worker | 高 |
| `db` | tracked / 初始 | 根 Next/D1/MySQL schema/adapter | 现阶段保留；未来数据库 owner 需裁决 | 三套 DB 配置漂移 | 高 |
| `deploy` | tracked / 初始 | Compose/Nginx/发布/回滚 | 根合理；可选 `infrastructure/deploy` | 文档新旧混杂 | 高 |
| `dist` | ignored/generated | Vinext/Vite 输出，约 8.8 MB | 当前保留；可再生 | lint/build 扫描需排除 | 高 |
| `Dockerfile.aliyun` | tracked / 初始 | Web + migrator | 根合理或未来 `deploy/docker/web` | `COPY . .` context 过宽 | 高 |
| `Dockerfile.api` | tracked / API deploy | API 镜像 | 同上 | 根 context 耦合 | 高 |
| `Dockerfile.worker` | tracked / Worker | Worker 镜像 | 同上 | 复制无关 vendor | 高 |
| `docs` | tracked / refactor blueprint | 架构、审查、验收 | 根合理 | 状态源重复 | 高 |
| `drizzle` | tracked / 初始 | D1/SQLite migration | 支持预览时合理 | 与 MySQL 双 lineage | 高 |
| `drizzle-mysql` | tracked / 初始 | 生产 MySQL migration | 必须保留；未来 `database/migrations/mysql` 只可机械迁移 | migration 历史不可改写 | 高 |
| `drizzle.config.ts` | tracked / 初始 | D1 生成配置 | 根工具配置合理 | 平台去留待裁决 | 高 |
| `drizzle.mysql.config.ts` | tracked / 初始 | MySQL 生成配置 | 根工具配置合理 | 与路径移动强耦合 | 高 |
| `eslint.config.mjs` | tracked / 初始 | 全仓 lint | 根合理 | overrides/ignore 不完整 | 高 |
| `examples` | tracked / 初始 | D1 notes 示例 | 保留；未来 `examples/d1` 已有边界 | 无生产引用，是否支持待确认 | 中高 |
| `GITHUB_PACKAGE_MANIFEST.md` | tracked / 初始 | Git 建库前协作包清单 | 本次不移动；未来用 `git mv` 迁入项目内历史文档归档 | 当前流程已过时 | 高 |
| `GITHUB_UPLOAD_GUIDE.md` | tracked / 初始 | 网页上传指南 | 本次不移动；未来用 `git mv` 迁入项目内历史文档归档 | 已有 Git remote 后过时 | 高 |
| `next-env.d.ts` | ignored/generated | Next 类型声明 | 根自动生成 | 不应手改 | 高 |
| `next.config.ts` | tracked / 初始 | Next standalone/externals | 根 Web 尚在根时合理 | 未来 Web 移动需同步 | 高 |
| `node_modules` | ignored/generated | workspace 安装产物 | 当前保留；可再生 | 不得进入 Docker/context 扫描 | 高 |
| `outputs` | ignored/local archive | 旧 prod/config tar、ZIP、SHA、展开副本，约 13.7 MB | 本次不移动；逐项分类后迁入 `archive/deliveries/` 等子目录 | 交付/审计价值，绝不能直接清理 | 高 |
| `package.json` | tracked / 初始 | 根 Web workspace 与统一命令 | 根合理 | `test` 不覆盖所有 workspace | 高 |
| `packages` | tracked / API runtime | 当前仅 contracts | 合理 | 不应预建空 shared 包 | 高 |
| `pnpm-lock.yaml` | tracked / 初始 | 四 importer 锁文件 | 根必须保留 | 跨 runtime 升级耦合是 monorepo 取舍 | 高 |
| `pnpm-workspace.yaml` | tracked / 初始 | `.`, `apps/*`, `packages/*` | 根必须保留 | policy 与 package scripts 需一致 | 高 |
| `postcss.config.mjs` | tracked / 初始 | Tailwind/PostCSS | Web 在根时合理 | 无显著债务 | 高 |
| `PROJECT_STATUS.md` | tracked / 初始 | 状态记录 | 本次不移动；内容需另批更新，未来是否归档按状态源裁决 | 停留单 systemd 拓扑 | 高 |
| `public` | tracked / 初始 | Web 静态资源 | Web 在根时合理 | `og.png` 约 1.72 MB，应有来源/压缩记录 | 高 |
| `README.md` | tracked / 初始 | 项目入口 | 根必须保留并更新 | 架构/部署陈述过时 | 高 |
| `scripts` | tracked / 初始 | build/migration/release/fence/bootstrap | 根合理；未来可分组但不急搬 | 命名/入口分散 | 高 |
| `SECURITY.md` | tracked / 初始 | 安全约束 | 根合理 | 需与 CI 门禁联动 | 高 |
| `tests` | tracked / 初始 | Web/legacy/跨服务门禁 | 根合理；未来明确 `tests/system` | 与 package tests 分散 | 高 |
| `tsconfig.json` | tracked / 初始 | 根 Web TS | 根合理 | glob 过宽，易扫入本地源码副本 | 高 |
| `tsconfig.tsbuildinfo` | ignored/generated | TS cache，约 0.42 MB | 当前保留；可再生 | 非源码 | 高 |
| `types` | tracked / 初始 | Cloudflare ambient types | 支持预览时合理 | 当前含 ESLint any | 高 |
| `vendor` | tracked / Stage 4 | 固定 `xlsx-0.20.3.tgz` | 必须保留，当前 package 直接引用 | 来源/许可证/哈希责任需文档化 | 高 |
| `vite.config.ts` | tracked / 初始 | Vinext/Cloudflare/Sites | Web 在根时合理 | 绑定 `.openai/build/worker` | 高 |
| `work` | ignored/local | 6 张架构 PNG，约 0.85 MB | 本次不移动；逐项确认后迁入 `archive/diagrams/` | 无引用不等于可删 | 中 |
| `worker` | tracked / 初始 | Cloudflare Web adapter，不是业务 Worker | 支持预览时保留；未来可改清晰名 | 与 `apps/worker` 同名异义 | 高 |

### 5.2 29 个 `topology-scm-*.tar.gz`

共同证据：全部 ignored/untracked，mtime 为 2026-07-30 至 2026-08-04，早于 2026-08-11 初始 Git 提交；合计 695,722 bytes、122 个普通文件成员。逐成员 SHA-256 复核结果为 15 个字节相同、107 个在当前树已有对应但内容已演化、0 个无当前对应。结论是“已吸收的历史交付/热修快照”，不是当前部署制品，也不是可直接删除的缓存。本次审计不移动；后续 Wave 3 将在字节不变、manifest 和恢复验证成立后迁入项目内 `archive/legacy-deliveries/`。

| 文件名 | bytes / mtime / SHA-256 | 顶层/成员/当前相同-变化-缺失 | 功能阶段与价值 | 建议 / 置信度 |
| --- | --- | --- | --- | --- |
| `topology-scm-admin-bootstrap-20260730.tar.gz` | 4,548 / 07-30 12:34:17 / `423ea59af1e26a8efd521ab620b1d701f9c0247b7ae571e77d9e4938e0d6816c` | app, package, scripts / 3 / 1-2-0 | 管理员 bootstrap 回滚/审计 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-ali-oss-external-20260730.tar.gz` | 289 / 07-30 11:57:24 / `9e2fcd32ebbc131f43271bd280ddc2cb0ad91756bb7c8a6c2724f48b003d1b4c` | next config / 1 / 1-0-0 | OSS 外置配置热修；`next.config.ts` 与当前文件 SHA-256 相同 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-aliyun-sms-20260730.tar.gz` | 93,591 / 07-30 13:06:13 / `1703e265d84932d760370b6eed65cfe9eb1c1413a5a52edf96c5593c0da6f267` | env, app, deploy, package, lock / 7 / 2-5-0 | SMS/OSS/登录依赖联动快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-audit-center-20260802.tar.gz` | 4,510 / 08-02 16:34:25 / `50960bdb54da101d1fbd47a04b86df089ce18ef1af27903dbbb19743470af380` | app, deploy / 3 / 1-2-0 | 审计中心；部署文档仍点名引用 | 本次不移动；Wave 3 连引用迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-bom-versions-20260802.tar.gz` | 30,272 / 08-02 16:09:55 / `b1e3ddbe894f55dc58ac9a409bd9709ced4a2784ac3a0133a5fc2b2c8995806a` | app, deploy / 7 / 2-5-0 | BOM 版本/审批阶段快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-delivery-performance-v1-20260802.tar.gz` | 4,478 / 08-03 04:07:39 / `921556e8107d6aa0819f0e4bde73eb69b4c0a2b3ec49f2b7f80541751c96d1df` | app / 1 / 0-1-0 | 交付绩效 v1，已被后续演化 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-finance-20260801.tar.gz` | 33,407 / 08-01 22:11:47 / `e8b0f6385f88b92b96296633e1145a5ec779bf6533d557f48bddbb8d6d717c2f` | app / 4 / 0-4-0 | 财务工作台阶段快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-finance-exceptions-20260802.tar.gz` | 12,547 / 08-02 01:53:09 / `61c1daa232a389a105e18ebbbc0802caefeddda469276a194bac52c2c83ac5f8` | app, deploy / 5 / 2-3-0 | 财务异常；部署文档仍点名 | 本次不移动；Wave 3 连引用迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-health-log-20260730.tar.gz` | 703 / 07-30 11:51:49 / `20491f1989465b6422fba648638a5ffd51fe62e98379540c58569ca333ab6ba7` | app / 1 / 1-0-0 | health 日志已精确吸收 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 中高 |
| `topology-scm-inventory-transfer-20260801.tar.gz` | 43,187 / 08-01 02:01:49 / `c4d2f374ef4af8d402d3bd670aafa8204ea16c4f2a9781c7ea6b3475e9941f2d` | app / 6 / 0-6-0 | 调拨原子化前历史 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-master-data-20260801.tar.gz` | 43,609 / 08-01 12:57:10 / `6d510dd5e56e9bce269a7a763b7b57226b004b8d0301f57cab86470cced167f5` | app / 5 / 0-5-0 | 主数据迁移前快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-order-confirmation-20260731.tar.gz` | 9,259 / 07-31 23:36:24 / `b8ae10b4041c78e03d0774da59503a4ef8634f391bca1f47e5efe79c1784a6f2` | app / 3 / 0-3-0 | 采购单确认阶段 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-oss-esm-fix-20260730.tar.gz` | 1,454 / 07-30 01:24:50 / `77bf6d900f4e1cd23c46277e5c3391eac576d80b00dd8192151d5940d00ff283` | app / 1 / 0-1-0 | OSS ESM 热修证据 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-oss-imdsv2-fix-20260730.tar.gz` | 1,651 / 07-30 11:42:48 / `747176caa808c616472600931b9e29d7e406705bac21037aaac3fa4e03ce1387` | app / 1 / 0-1-0 | IMDSv2/RAM 安全演进 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-production-flow-20260731.tar.gz` | 41,624 / 08-01 00:47:46 / `73c39179a9f2e644463d683c52b587da3958c6b059ae8e6a8db40948d0d36e49` | app / 5 / 0-5-0 | 生产流程阶段快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-production-inventory-20260801.tar.gz` | 8,351 / 08-01 14:37:32 / `488659c0e917ded1f16e4301a830c6bf6331cecfbd2bc49b27e0955f014962c6` | app / 3 / 1-2-0 | 生产入库 helper 演进 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 中高 |
| `topology-scm-purchase-execution-20260801.tar.gz` | 13,591 / 08-01 17:33:53 / `0554c78e0c6b0cb13079711cbe1936ed0e0607dc312f7fe4454f849e5b7c7e12` | app / 4 / 0-4-0 | 采购执行阶段快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-purchase-workspace-20260731.tar.gz` | 42,124 / 07-31 22:37:29 / `908672541a9fc709ffe15da6493b502c3ea30edebb5c9938de96352527d5431e` | app / 6 / 0-6-0 | 采购 UI/API 快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-quality-performance-v1-fixed-20260803.tar.gz` | 4,480 / 08-04 16:18:28 / `2f021fcb0b8f03a6f2ce2c377a1166ed0faa04a2891dc566e62ff3ea4988b248` | app / 1 / 0-1-0 | 质量绩效修正版 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-real-admin-stepup-20260731.tar.gz` | 38,401 / 07-31 18:13:39 / `5dc0d4f434bf8ac86a7c0fce684ca7eaf232b209d8c659dd76173636e20bcf98` | app / 6 / 0-6-0 | 管理员/Step-up 安全历史 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-role-approval-20260731.tar.gz` | 6,152 / 07-31 17:12:08 / `9fae496e1db3ea7df9074a392b4f27bf91cbeb9dc40f8c4e532f9452f071526f` | app / 3 / 0-3-0 | 角色/审批/authz 历史 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-shipping-returns-20260801.tar.gz` | 35,042 / 08-01 20:48:09 / `5a5549c51e32e73ed6919a9290581d675d8979a112bf3d538eebc6804a6b6eed` | app / 5 / 1-4-0 | 发货/退货阶段快照 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-stocktake-20260801.tar.gz` | 26,060 / 08-01 12:23:42 / `30bf39ae0bcd3b99a3962527e1a34de9ddf1ade7a7b6e395d37bcfe472792323` | app / 8 / 1-7-0 | 盘点/freeze 演进历史 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-supplier-network-20260801.tar.gz` | 45,109 / 08-01 15:43:31 / `71b4b94c8de1e3ca56febfd1d244a95add51b733ec992040f77d158209e819ee` | app / 6 / 0-6-0 | 供应商网络阶段 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-supplier-performance-20260802.tar.gz` | 69,631 / 08-02 17:29:06 / `14118c2f22f0df71afe808a43a3a0bd9cea57b80b0a693ab00ce186ebbf5b82d` | app, db, drizzle-mysql / 10 / 1-9-0 | 含 schema/migration，lineage 取证价值最高 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-supplier-performance-mysql-fix-20260802.tar.gz` | 28,742 / 08-02 18:40:48 / `9aeee436b76c5008b78584cc4a80ff9a1d658f0562b80739da89a7ffeb0b5cc6` | db, drizzle-mysql, scripts / 5 / 1-4-0 | MySQL migration 修复 lineage | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-supplier-performance-stable-v1-20260804.tar.gz` | 4,479 / 08-04 17:39:59 / `f9d72eb5b3295ffb3acea21d646f3b8856340687a051d363f4b8976cd5b660f4` | app / 1 / 0-1-0 | 绩效 stable v1 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-supplier-pricing-20260801.tar.gz` | 25,994 / 08-01 16:59:51 / `0380d3af55cbe16a05f58f2c16dd66c4c4dfa920f4b7217ec8d73d13b93df30f` | app / 6 / 0-6-0 | 定价/文件/审批历史 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |
| `topology-scm-warehouse-management-20260801.tar.gz` | 22,437 / 08-01 13:48:20 / `58f30d37095657524e354251f409959e134847f87c3fa3244639197b6524e2eb` | app / 5 / 0-5-0 | 仓库管理阶段 | 本次不移动；Wave 3 迁入 `archive/legacy-deliveries/` / 高 |

> 注意：`audit-center` 与 `finance-exceptions` 的 tracked 部署文档仍按根目录文件名引用 tar。迁入 `archive/legacy-deliveries/` 时必须在同一机械批次同步修订或历史化相应文档，并由 tracked manifest 保留原路径、归档路径、SHA-256、mtime、用途与恢复方法。

## 6. 目标结构：先明确所有权，再决定是否搬目录

### 6.1 当前到近期目标映射（推荐）

| 当前 | 近期目标 | 是否本阶段移动 | 理由 |
| --- | --- | --- | --- |
| 根 `app/` | 明确为 Web package；只允许页面、组件、同域 bridge 和必要平台兼容 | 否 | 避免 Next/Vinext/Docker 路径噪音 |
| `apps/api` | canonical Fastify API | 否 | 已有独立边界 |
| `apps/worker` | canonical 后台 Worker | 否 | 已有独立边界 |
| `worker/` | 明确命名为 Cloudflare Web adapter（文档/注释先行） | 暂不移动 | 是否继续支持预览待裁决 |
| `packages/contracts` | API Schema/DTO/command identity 唯一事实源 | 否 | 避免新建空 shared 包 |
| 根 `db` + 两套 drizzle | 先明确 D1 preview 与 MySQL production ownership、生成关系 | 否 | migration history 不可与目录搬迁混批 |
| 根 `tests` | 标记为 system/legacy/deployment tests；统一入口覆盖所有 package | 暂不移动 | 先解决门禁，再机械分类 |
| `scripts`/`deploy`/Dockerfile | 建立命令目录与制品责任表 | 暂不移动 | 发布路径高风险 |
| tar/`outputs`/`.tmp`/`work` | 建 tracked manifest；后续按类别迁入项目内 `archive/` | 本次否；Wave 3 受控移动 | 未知资产默认归档保留，删除需逐项授权 |

### 6.2 可选长期形态（不是本轮既定答案）

若后续 clean build 和部署证明可安全搬迁，长期可形成：

```text
apps/
  web/                 # 可选：仅在根 Web 搬迁门禁通过后
  api/
  worker/
packages/
  contracts/
tooling/               # 仅容纳已有且跨包复用的 lint/ts/build helper
database/              # 仅在 migration owner 与 D1 去留裁决后
  schema/
  migrations/
  tooling/
archive/               # 项目内历史/未知资产；整体排除 Docker context
  README.md             # tracked：分类、保留、敏感与恢复规则
  manifests/            # tracked：原路径→归档路径、SHA-256、mtime、用途
  legacy-deliveries/    # ignored：29 个历史 tar 等二进制交付包
  deliveries/           # ignored：outputs 中经确认的交付制品
  working-notes/        # 默认 ignored：.tmp 中经确认有保留价值的记录
  diagrams/             # 默认 ignored：work 中经确认的历史图像
deploy/
tests/                 # system/contract/deployment；package tests 仍贴近 package
```

这仍是**前后端分离的 monorepo**：应用源码和发布单元分开，但 Git/lock/contracts 可以共享。`archive/` 是项目内受控历史区，不是 runtime package、构建输入或部署制品；其 README/manifest 可跟踪，二进制与可能敏感内容默认 ignored。是否改成 multi-repo 必须另做组织和发布裁决。

明确不预建：`shared-config/`、`test-support/`、`modules/`、`domain/`、`repository/`、`service/`。只有至少两个真实消费者、稳定 API 和可量化重复时才创建。

## 7. 工程债务清单

风险层次：机械风险指路径/构建/工具变化；行为风险指运行或接口改变；业务风险指权限、状态机、SQL 或事实含义改变。后续任何批次都必须保持业务风险为“无”。

| ID | 债务与精确证据 | 影响 | 目标 | 风险 | 依赖/工作量 | 验证与回滚 | 优先级 / 用户裁决 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N-001 | README/PROJECT_STATUS 仍描述单 systemd；Stage 6/Compose 已是三服务 | 新人/运维执行错误流程 | 设 README 为当前入口，历史状态明确归档标签 | 机械低、行为无、业务无 | 小 | 链接抽查、命令与 Compose 对照；回滚文档提交 | P0 / 否 |
| N-002 | `.github` 仅 PR template；根 `pnpm test` 不运行 API 43 + Worker 3 个 `*.test.mjs` | 本地证据无法自动复现 | CI matrix 覆盖 lint/TS/root/API/Worker/build/migration safety | 机械中、行为无 | 中；先统一 scripts | clean install + 全门禁；回滚 workflow | P0 / 是否启用 GitHub CI 需确认 |
| N-003 | ESLint 28/117，且误扫 `apps/api/dist`、`.tmp`，Node test 受 Next rule | 告警失真，无法设零基线 | 分 Web/API/Worker/tests/types overrides；先排生成物再逐类清债 | 机械中、行为低 | 中 | 固定 JSON 基线逐批下降；回滚 config | P0 / 否 |
| N-004 | `.dockerignore` 未排 tar/store/tsbuildinfo；Web Docker `COPY . .` | context 污染、缓存不稳、历史内容进入 builder | 当前根资产与未来整个 `archive/` 均排除 Docker context；用 build 反证 | 机械中、行为中 | 小 | 三镜像 no-cache build + 内容审查；回滚 ignore | P0 / 项目内归档原则已裁决 |
| N-005 | `.gitignore /build/` 与 tracked `build/sites-vite-plugin.ts` 冲突 | 新源码可静默漏提交 | 改清晰 tooling 路径或精确 ignore | 机械中、行为低 | 小 | 新文件可见性测试 + Web build；回滚路径提交 | P1 / D1/Sites 去留需确认 |
| N-006 | `worker/` 是 Web edge adapter，`apps/worker` 是业务 Worker | 高认知/脚本 glob 风险 | 先文档改名；平台保留时再机械移动 adapter | 机械中、行为低 | 小-中 | Vite/Web/Worker build；回滚 move | P1 / 预览平台去留需确认 |
| N-007 | `.env.example` 24、生产模板 37、Compose 31，默认来源不清 | 环境遗漏、健康假阳性 | 建变量 owner/消费者/必需性矩阵；分本地与生产示例 | 机械中、行为中 | 中 | env check 正反例、Compose config；回滚 config | P0 / 否 |
| N-008 | root/API/Worker 三套 DB pool/TLS/default；D1/MySQL 双 schema | 配置漂移、方言/超时差异 | 先记录 runtime DB contract；仅共享纯配置解析，不合并生命周期 | 行为高 | 中-大 | 真实 MySQL deadline/TLS/transaction tests；回滚独立 | P1 / D1 是否正式支持需确认 |
| N-009 | `suppliers/index.ts` 1840、database.ts 1006、多文件 >500 | 审查半径大、冲突与回归定位差 | 按真实变更簇拆文件，保持公开注册入口不变 | 机械中、行为中 | 大、分模块 | 字节/HTTP contract、SQL snapshot、负向权限；逐提交回滚 | P1 / 否 |
| N-010 | R2 34、R3 32 文件广义命中；含持久化 identity | 迁移阶段词污染长期领域语言 | 先区分路径名/内部 symbol 与持久化 command/resource；只改前者 | 机械高、行为高 | 中 | identity manifest 零变化、DB facts、API tests；回滚 rename | P2 / 名称映射需确认 |
| N-011 | 32 个 retired route 文件仍占 Next tree；根 DB imports 尚存 | 搜索噪音、误用风险 | 建 legacy inventory：退役边界、平台兼容、预览支持三类；满足证据才删除实现 | 行为高 | 中 | 全路径 410、调用检索、生产日志、回滚窗口 | P2 / 删除必须再次授权 |
| N-012 | Web 仍手写 API helper/DTO；contracts 主要仅 API 消费 | 合同漂移、重复映射 | 先统一现有手写 client 边界；API 稳定后再裁决生成 Client | 行为中 | 中-大 | contract tests、Web build、错误映射 | P2 / 生成器/依赖需另批批准 |
| N-013 | `tests/`、API tests、Worker tests 分散且根命令不聚合 | 开发者误以为 `pnpm test` 是全量 | 定义 `test:unit/integration/system/all`，fixture 生命周期一致 | 机械中、行为低 | 中 | 命令矩阵、无 DB 时 skip/有 DB 时必跑 | P0 / 否 |
| N-014 | 29 tar + outputs/tmp/work，无 canonical 资产 manifest | 误删历史、错误回滚、潜在敏感传播 | 在项目内建立 `archive/`：移动前先提交完整 `planned` manifest，二进制默认 ignored，成功后更新为 `archived` | 机械中、业务/合规未知 | 中 | 移动前后 SHA/bytes/mtime、恢复 dry-run、敏感扫描、Docker context 排除；按预登记命令反向移动 | P0 / 总原则已裁决，删除仍需逐项授权 |
| N-015 | `vendor/xlsx-0.20.3.tgz` 为 file 依赖，来源/许可证/哈希责任未在入口文档 | 供应链不可追溯 | 记录来源、许可证、SHA、升级与 advisory 流程 | 机械低、行为无 | 小 | hash + license + audit；回滚文档 | P0 / 来源需确认 |
| N-016 | D1/Vinext/Sites 与 Aliyun/MySQL 双平台；README 状态不明 | 双倍构建/DB/worker 认知成本 | 明确“正式支持/开发预览/历史兼容”矩阵 | 行为高 | 中 | 两平台 build/test 或正式退役计划 | P0 / 必须用户裁决 |
| N-017 | 根 tsconfig `**/*.ts(x)`；lint/config 也以全仓为默认 | 本地副本/生成物被误扫 | 为每 package 设显式 include，根只含 Web/共享配置 | 机械中、行为低 | 小-中 | 四套 TS、Next/Vinext build | P1 / 否 |
| N-018 | 规划文档建议 modules 四层，但当前模块多为 route+SQL+mapper；无证据支持全量 DDD | 若机械补层会继续增复杂度 | 只在超大模块拆分时引入有职责的 query/mapper/policy 文件 | 机械中、行为中 | 持续 | 文件依赖、无空目录、LOC/complexity/contract | P1 / 否 |
| N-019 | 三 Dockerfile、workspace install、vendor copy 有重复；Worker 复制无关 xlsx | 构建慢、镜像 closure 易漂移 | 提取可验证的 build policy，不急做复杂 base image | 机械中、行为中 | 中 | fresh build、生产 closure、nonroot/read-only/health | P1 / 新 base image 需另批 |
| N-020 | 安全不变量散布在平台/adapter/tests，易被“简化”误删 | 规范化可能回退安全边界 | 建不可删除不变量清单与 architecture tests | 行为高 | 中 | 负向安全、并发、unknown outcome、fence/outbox | P0 / 否 |
| N-021 | 10 个恒真 410 guard 后仍留 2,746 LOC 不可达旧主体 | 搜索、lint、审查和漏洞扫描噪音 | 经用户确认旧 writer 回滚退出后，逐域缩成薄 410 shim | 行为高 | 中 | legacy boundary + release/rollback；每域单独回滚 | P1 / 必须确认回滚承诺 |
| N-022 | `app ↔ db`：DB 4 条反向 import app/lib | 目录所有权混乱、潜在循环 | 只把 runtime-env/business-rules 机械移至中立位置 | 机械中、行为低 | 中 | 依赖图反向边为 0、Next/root tests | P1 / 否 |
| N-023 | R2 mapping 双份、canonical digest 3 份、18 个 no-store hook及多份 primitives | 漂移与安全 digest 不一致风险 | 每次只收敛一种完全同体 primitive；digest 单独高风险批次 | 行为中到高 | 中 | golden vector、Step-up/幂等/contract tests | P1 / 否 |

## 8. 不可为降 LOC 删除的安全不变量

以下复杂度是 Scope A 的必要复杂度；可以去重和改善命名，不能弱化语义：

- 服务端 Session、RBAC、组织 data-scope；菜单隐藏不能代替授权。
- CSRF 与 Origin 校验；本地 bridge 也必须遵守来源边界。
- Step-up 必须绑定 session、action、权威对象、毫秒级版本和 digest，并在同一事务消费。
- MySQL 事务、行锁、CAS、deadline、未知提交结果 fail closed。
- 幂等 key/digest、并发单执行、replay 与 unknown outcome 处理。
- writer fence/resource identity、generation 与发布/回滚兼容协议。
- audit/outbox 与业务事实同事务；Worker lease/retry/dead-letter/fence。
- 文件 quarantine、扫描、entity scope 和下载授权。
- scope-before-LIMIT、负向角色/组织测试。
- migration append-only、history hash/preflight、fresh/upgrade oracle。

## 9. 不值得做 / 暂不做

- 不拆微服务，不拆 Web/API/Worker 多仓；当前没有团队/权限/发布事实支持。
- 不引入 CQRS、事件溯源、service mesh、新消息队列、控制台或可观测性平台。
- 不创建空壳 DDD 四层、repository/service 接口或庞大 shared 包。
- 不为追求 LOC 数字压缩安全边界、合并错误职责或删除测试。
- 不一次性格式化全仓；格式化会掩盖目录/行为 diff。
- 不在同一批次同时做目录移动、命名、抽象和行为修复。
- 不立即生成前端 Client；先稳定现有契约与 client 边界，再单独评估生成器。
- 不全面拆 `db/schema.ts` 或改 migration 历史；schema 结构化必须保持生成和历史字节。
- 不把 tar、`outputs`、`.tmp`、`work`、D1/Sites 文件或历史指南当垃圾删除；历史/未知有价值资产按 Wave 3 迁入项目内 `archive/`，真正删除仍需逐项授权。
- 不实现 Scope B。

## 10. 后续实施波次（本任务不实施）

每个波次必须独立提交、可验证、可回滚；前一波未验收不得自动进入下一波。

### Wave 0：冻结基线与状态源

- 允许：`README.md`、`PROJECT_STATUS.md`、`CONTRIBUTING.md`、`docs/**` 中状态/导航文档。
- 禁止：源码、配置、lock、migration、API 合同、业务说明改义。
- 入口：当前 SHA 与 Stage 6 证据固定。
- 出口：唯一当前状态源、三 runtime 命令、Scope A/B 边界准确。
- 测试：链接/命令路径抽查；无生产构建必要。
- diff：docs-only；回滚整提交。

### Wave 1：工具边界与可重复门禁

- 允许：ESLint/TS config、package scripts、CI workflow、测试入口；必要的纯配置 fixture。
- 禁止：应用源码格式化、业务 test expectation 改义、新生产依赖。
- 顺序：先 ignore/override → 再聚合 scripts → 再 CI；不可混入告警修复。
- 入口：Wave 0 通过。
- 出口：lint 只扫源码；四套 TS；root/API/Worker/system 命令一键可重复。
- 测试：frozen install、四套 TS、lint JSON、所有非 MySQL与 MySQL矩阵。
- 回滚：逐个 config/CI 提交。

### Wave 2：构建 context 与环境契约

- 允许：`.dockerignore`、Dockerfile/Compose 的机械输入收窄、env 示例/检查脚本/文档。
- 禁止：运行时默认语义、密钥值、provider 行为、镜像新增依赖。
- 入口：CI 可复现。
- 出口：tar/本地缓存不进入 context；env 变量有 owner/required/default；三镜像 closure 不扩张。
- 测试：no-cache build、Compose config、env 正反例、nonroot/read-only/cap-drop/health。
- 回滚：单独 revert 构建批次。

### Wave 3：项目内资产治理与受控移动

- 允许：新增 tracked 的 `archive/README.md`、`archive/manifests/` 和必要目录占位；在完整 `planned` manifest 通过入口门禁后，把 29 个 tar 迁入 `archive/legacy-deliveries/`，把 `outputs`、`.tmp`、`work` 经逐项分类后分别迁入 `archive/deliveries/`、`archive/working-notes/`、`archive/diagrams/` 或 manifest 证明的其他子目录；tracked 历史文件只用 `git mv`；ignored/untracked 资产在同一文件系统优先原子 move，并保持字节不变。
- 禁止：移动任何未登记或入口门禁未通过的资产；删除、销毁或覆盖唯一副本；解压后改写；把二进制/可能敏感资产纳入 Git；把 `node_modules`、`.next`、`dist`、tsbuildinfo、pnpm store 等可再生产物误归档为必须永久保留的原始资产；禁止混入业务、配置重构或目录美化。移动导致旧路径消失属于受控迁移，不是资产删除；本 Wave 不销毁任何唯一副本。
- 入口：本报告的项目内归档总原则已批准；tracked manifest 已以 `planned` 状态完整登记每项的原路径、目标路径、SHA-256、字节数、mtime、来源、用途、tracked/ignored 状态、消费者/引用、敏感扫描结论及逐项恢复命令/方案；`archive/` 整体排除三 Docker context 已验证；恢复方案已用副本或等价 dry-run 验证；引用 29 个 tar 的部署文档已纳入同批路径更新计划。任一字段、扫描或恢复证据缺失都不得移动。
- 出口：29 个 tar 全部位于 `archive/legacy-deliveries/`；其他历史/未知资产均按 manifest 分类；每项移动后的 SHA-256、字节数、引用和恢复抽样复核通过；manifest 状态由 `planned` 更新为 `archived` 并记录完成证据；二进制仍 ignored；根目录不再散落已纳管交付资产；没有删除或销毁任何唯一副本。
- 验证：移动前以已提交的 `planned` manifest 冻结事实；移动阶段保持字节不变，同文件系统优先原子 move；每项移动后立即核对 SHA-256、字节数、mtime（无法保留时记录平台限制）、消费者/引用和抽样恢复，再将状态更新为 `archived`。同时验证 tracked 文件为可追溯 rename、部署文档引用有效、Git 未跟踪二进制/敏感内容、三 Docker context 均不含 `archive/`、clean build/test 不消费 archive。
- diff：manifest/README 与 Docker context 排除可先做独立提交；tracked `git mv`、ignored 资产移动和引用更新按类别拆成可审计提交，不与删除、格式化、业务修改混批。
- 回滚：任一步失败，立即执行 `planned` manifest 预登记的恢复命令/方案，把已移动资产反向移动到原路径并复核 SHA-256 与字节数，恢复原引用；tracked 文件 revert 对应 `git mv`。只有回滚验证通过后才能继续处理下一项。真正删除、销毁唯一副本或去重不属于移动/回滚或本 Wave，必须另行逐项授权。

### Wave 4：命名与目录的纯机械批次

- 允许：先解决 `worker/` 同名、`build/` ignore 冲突；可选 `apps/web` 另开独立批次。
- 禁止：业务代码改义、格式化、抽象、API/SQL/migration/identity 改名。
- 入口：D1/Sites 支持状态已裁决；clean build 可复现。
- 出口：所有 imports/config/Docker 路径更新，Git rename 可审计，生产行为不变。
- 测试：Web/API/Worker build、Docker、route、preview（若支持）。
- 回滚：整批 rename revert。

### Wave 5：真实代码质量修复

- 允许：按规则/目录小批修 Hooks、类型、unused vars；每批只一种规则。
- 禁止：顺手重命名/搬目录/格式化全文件、业务状态机或 API 合同改变。
- 入口：lint 误扫已消除。
- 出口：errors 分批降到 0，warnings 有批准基线；行为测试不变。
- 测试：相关组件测试、Web build、全 lint；逐规则回滚。

### Wave 6：超大模块拆分

- 允许：一次只拆一个模块的 query/mapper/policy/route registration；公开入口不变。
- 禁止：新 repository/DDD 空层、SQL/权限/状态机改变、跨模块重写。
- 入口：该模块契约、负向权限、SQL-before-LIMIT 测试充足。
- 出口：最大文件下降、依赖方向清晰、无循环、测试等价。
- 测试：HTTP contract、错误码、SQL参数、真实 MySQL、负向 scope。
- 回滚：每模块一提交。

### Wave 7：legacy 与阶段命名减法

- 允许：有零调用/410/回滚窗口证据的 legacy 实现删除；内部 R2/R3 路径与 symbol 稳定命名。
- 禁止：更改持久化 command/resource identity、writer generation、migration history、API 合同。
- 入口：调用证据、identity mapping、生产回滚策略明确。
- 出口：无第二业务实现；阶段名仅保留在兼容协议/历史文档。
- 测试：identity manifest 零 diff、legacy 路径、API/Worker/MySQL、release/rollback。
- 回滚：删除与 rename 分成不同提交。

### Wave 8：可选 Web 搬迁或多仓复议

- 允许：经单独裁决后机械移动根 Web package 及其专属配置；若评估 multi-repo，只允许产出拆仓决策记录、contracts 版本策略、release BOM 和迁移演练，不直接拆仓。
- 禁止：同时修改 UI、格式、API client、业务逻辑、权限、SQL、API 合同、migration、writer identity、依赖版本或生产部署语义；multi-repo 不得由本计划自动触发。
- 入口：Wave 0–7 全部通过；根 Web 的所有构建输入/引用已枚举；D1/Vinext/Sites 去留已裁决；若评估拆仓，必须已有独立团队、权限或发布节奏的书面证据。
- 出口：若移动到 `apps/web`，新旧路径映射 100%、根不再承载 Web package、三运行时独立构建与联合发布门禁均保持；若只做多仓复议，则形成明确 GO/NO-GO，不产生代码迁移。
- 验证：frozen install、四套 TypeScript、lint、root/API/Worker tests、Web/Vinext/Aliyun build、三 Docker 镜像、Compose/Nginx、legacy bridge、D1 preview（若仍支持）、migration/release/rollback 和生产 closure。
- diff：Web 目录移动与配置路径改写必须是单独的机械批次；多仓决策只能是 docs-only，不能与目录移动混批。
- 回滚：Web 移动整提交 revert 后重跑同一门禁；多仓评估仅回滚文档。任何行为差异、制品缺失或跨仓兼容未证明均立即 NO-GO。

## 11. Scope B 排除项

后续所有规范化波次均不得实现或改变：

- Purchase Receipt / 采购收货与来料入库；
- BOM 真实库存批次预留、领料、消耗；
- 成品质检后的库存放行、隔离与处置闭环；
- Receiver / LegalEntity 新模型；
- 真实银行付款指令；
- 新业务状态机或现有角色、权限、状态机、SQL 语义；
- API 合同、migration 历史、writer identity 的业务性变化。

发现这些需求时必须停止工程批次，单独进入 Scope B 业务裁决。

## 12. 验收标准与停止点

### 12.1 本文验收

- 根目录 80/80 覆盖；29 个 tar 逐项有名称、大小、mtime、SHA、成员、来源/阶段、吸收状态、价值、建议和置信度。
- 当前到目标映射完整，且没有把 `apps/web` 或 multi-repo 预设为答案。
- 机械、行为、业务风险分层；所有波次有允许文件、禁止项、入口、出口、验证、diff 和回滚。
- TypeScript 与 ESLint 基线可复现；LOC 不是唯一指标。
- 不新增组件/依赖；本次审计不移动或删除原始资产；后续仅按 Wave 3 门禁迁入项目内 `archive/`，不越入 Scope B。

### 12.2 后续总体 GO 条件

- 文档、CI、lint、TS、test、Docker/env 的事实源唯一且可重复；
- 目录移动前已冻结行为 oracle；
- legacy 删除有零调用和回滚窗口证据；
- R2/R3 内部重命名不改变任何持久化 identity；
- 所有安全不变量和真实 MySQL 并发/失败证据保持；
- 生产源码复杂度实际下降，但不以 LOC 诱导删除安全代码；
- 原始资产按已批准的项目内归档原则，只有在 tracked `planned` manifest 已完整记录原/目标路径、SHA-256、字节数、mtime、来源、用途、tracked/ignored、消费者/引用、敏感扫描结论和经副本或等价 dry-run 验证的恢复方案，且 `archive/` Docker 排除已验证后才可移动；移动后立即复核并将状态改为 `archived`。旧路径消失是受控迁移而非删除；真正删除、销毁唯一副本或去重仍需逐项授权。

任一波次出现业务语义、生产凭据、不可逆 migration、未知资产来源或无法解释的测试变化，立即 NO-GO 并回滚该批次。

## 13. 需用户裁决的事项

1. D1/Vinext/Sites/Cloudflare preview 是否仍是正式支持目标、仅开发预览，还是未来退役。
2. 29 个 tar、`outputs/`、`.tmp/`、`work/` 的具体保留期、项目内 `archive/` 子目录、责任人和敏感等级；项目内保留、未知资产默认归档及删除另行授权的总原则已确认。
3. `audit-center`、`finance-exceptions` 两份 tar 部署文档是否仍受支持。
4. 是否把 GitHub Actions 作为正式 CI；若是，哪些门禁可使用 Docker/MySQL runner。
5. README、PROJECT_STATUS、deploy README 中谁是唯一当前状态源。
6. `vendor/xlsx-0.20.3.tgz` 的来源、许可证、SHA 与升级责任记录在哪里。
7. 长期是否确有独立团队/权限/发布节奏，足以支持 multi-repo；当前默认答案为否。
8. 是否在后续纯机械波次把根 Web 移入 `apps/web`；当前不影响前后端分离结论。

---

最终裁决：**工程规范化应继续，但必须采取“先事实源与门禁、再构建/资产治理、后机械移动与模块减法”的顺序。当前最合适的目标是边界清晰的多运行时 monorepo，而不是为了目录美观立即拆仓或重排全部文件。**
