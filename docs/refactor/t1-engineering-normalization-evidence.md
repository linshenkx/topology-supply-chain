# T1 工程基线与仓库治理验收证据

> 基线：`db63839bcd4ce8c852a18310f1f0ef7bca83c269`
>
> 分支：`codex/normalization-repository-governance`
>
> 口径：本地验收；任务禁止 push，因此不声称 GitHub Actions 已运行或绿色。

## 结果边界

- 生产主链保持 Aliyun + RDS MySQL + OSS；D1/Vinext/Sites/Cloudflare 仅为开发预览与兼容。
- 未执行 `apps/web` 搬迁、依赖升级、Schema/SQL/migration 修改、业务规则/API/状态机/权限修改、writer activation、deploy 或 Scope B。
- release manifest 的 canonical stdout 在机械移动前后相同；原生字节 SHA-256 为 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`。35-command、resource、R2/R3 与 rollback identity 合同未变化。

## 仓库与源码度量

| 指标 | Before | After | 结论 |
| --- | ---: | ---: | --- |
| 根一级条目（含 `.git` 与 ignored） | 80 | 50 | 29 个根 tar 与 `.tmp`/`outputs`/`work` 散落入口移入项目内 archive；无资产删除 |
| 生产 TypeScript 文件 | 179 | 179 | 仅两个 100% rename |
| 生产 TypeScript LOC | 35,885 | 35,885 | 字节内容不变 |
| 最大生产文件 | `apps/api/src/modules/suppliers/index.ts` / 1,840 | 同左 | 未混入拆分或业务重写 |
| `db -> app` 反向 import | 4 | 4 | 目录级潜在 `app ↔ db` 循环未扩大；超出 T1 机械 owner 范围 |

生产源码口径为 Web、API/Worker/Contracts src、DB、edge adapter、Sites plugin、ambient types 与根 TypeScript config；before 从基线 Git object 读取，after 从 index 读取。

## Archive 证据

- `archive/manifests/assets.json` 在任何内容调查或移动前以 `planned` 提交冻结 343 项 source→target 映射。
- 29 个 legacy delivery、278 个 delivery output、30 个 working note、6 个 diagram，共 15,832,433 bytes；逐项记录 SHA-256、bytes、mtime UTC、tracked 引用与敏感扫描元数据。
- 23 项含 secret-like/MySQL credential-like 形态，只记录类别/次数，不记录值；内容持续 ignored/protected，未进入 Git 或 Docker context。
- 移动前恢复 dry-run 把 343 项复制到任务临时目录并逐项复核 SHA-256，随后清理临时副本；移动后 SHA-256、bytes、mtime 再次全部匹配。
- 两个仍消费历史 tar 名称的部署文档已更新为 `archive/legacy-deliveries/...`；Git 仅跟踪 archive README 与 manifest，不跟踪历史二进制。

## 构建、运行与部署边界

| 镜像 | Final image ID | Size | 运行边界 |
| --- | --- | ---: | --- |
| Web | `sha256:0112b6736d0b7066a424de10245dde295c4528b344660d95168f5f2151a305c8` | 189,863,101 | `nextjs`; read-only; cap-drop ALL; no-new-privileges |
| API | `sha256:e280e4c3fcc9bfc9e5404b9bdb3cb185fb3d7835c5edc4bbb632ee19e33da3d2` | 189,944,263 | `api`; read-only; cap-drop ALL; no-new-privileges |
| Worker | `sha256:4c98f1b5a329195ebdbcf73c22e51627981a84cefc1b71d0a8d05245a0feb4dc` | 169,048,856 | `worker`; read-only; cap-drop ALL; no-new-privileges |

三镜像均从最终源码执行 `--no-cache` fresh build，重新执行 frozen install、供应链 lock policy 与对应 build；runner health 声明保持 Web `/api/health`、API `/api/v1/health/live`、Worker `/health/live`。

运行态使用任务专属 MySQL/provider：Worker ready 200，API ready 200 且 mysql/provider 均 ok；API 保留调用方 `x-request-id`。Web `/api/session` 保持未登录 401；在禁止生产 OSS 凭据的条件下，Aliyun `/api/health` 为受控 503，响应只显示 application/database ok 与 objectStorage failed，不泄露凭据。

Compose `config -q`、原生 `--dry-run up -d --no-build app api worker` 与 deploy/rollback/configure 脚本 `bash -n` 通过；未 deploy、未创建 Compose runtime。环境合同覆盖 42 个变量 owner/consumer，Docker context 合同覆盖 17 个 archive/cache/generated 排除项。

## 验证记录

- `pnpm install --frozen-lockfile`：通过，pnpm 11.9.0。
- `pnpm verify:local`：最终完整通过；四套 TypeScript、lint regression（真实存量 23 errors/113 warnings）、Vinext/Contracts/API/Worker build、343 non-MySQL tests、4 Web HTTP tests、Aliyun Next production build，0 skip。
- `pnpm verify:mysql`：8 个真实 MySQL integration 文件，21 tests，0 fail / 0 skip；覆盖 lock/CAS/idempotency/deadline、transactional audit/outbox、quarantine/ACL、writer fence/activation、fresh install、migration upgrade/history 与 rollback fail-closed。
- command/resource/R2/R3/release/rollback 定向合同：33 tests，0 fail / 0 skip。
- 首次最终 `verify:local` 的 non-MySQL 子阶段曾汇总 342 pass / 1 fail，但截断输出未保留失败项；相同入口立即完整复跑为 343/343，随后完整 `verify:local` 再次为 343/343 + 4/4。未对无法复现的瞬态失败作代码掩盖。
- `pnpm audit --audit-level high`：未通过，报告 25 个 baseline lockfile finding（14 high），位于 Cloudflare/Vinext/Vite/ESLint 等开发依赖树；T1 禁止依赖升级，lockfile 与基线字节一致，因此如实记录为未决债务，不宣称 audit 绿色。镜像内 frozen lock policy、vendored XLSX 与 fast-uri policy 均通过。

## NO-GO 项

- database/双 migration lineage、scripts/deploy 路径：source/generated/运行 owner 风险大于机械收益，保持原位。
- 内部 R2/R3 path/symbol：与 command/resource/writer/audit/migration identity 混杂，T1 不改名。
- `apps/web`：明确后置可选，本任务禁止。
