# Implementation Notes

## Source

- 用户委派的 Stage 9 T2 合同：仅从 accepted T1 SHA `228de77b97e42e8b571871048c425ebd5712cbc0` 清零非业务质量与安全债务，冻结业务语义、公共 API、权限、Schema、migration 字节与持久化 identity。
- 上位计划为 `docs/refactor/stage9-physical-separation-orchestration-plan.md` 第 5 节；本任务是唯一项目写者并使用原生 Goal。

## Design Decisions

- 18 个退役 route 的 accepted-T1 完整源码保存为确定性 tar source snapshot；manifest 记录原路径、successor、字节数、SHA-256 和 snapshot member，验证器同时执行敏感扫描、closure 断言与逐字 restore dry-run。
- source snapshot 放在既有 `archive/` 所有权下并显式保持 lint、TypeScript、Docker、构建和发布闭包之外；live route 只保留逐方法薄 `retiredPlatformRoute` shim。

## Deviations

- 用户已裁决恢复任务：`vinext@0.0.50 -> image-size@2.0.2` 的两项开发/预览构建链 High 作为有期限上游例外，其余项目可控 Critical/High 仍须清零，生产 audit 必须为 0。

## Tradeoffs

- 使用标准 tar 而非新建通用归档包，保持可移植恢复证据并避免把历史 TypeScript 重新纳入工具链。
- 依赖簇严格串行；既有 `image-size` 例外不自动类推到任何新发现，新的无正式安全路径依赖仍须停止并请求裁决。

## Open Questions

- 无。`image-size` 例外禁止 pnpm override、patch-package、私有/Git fork、虚构安全版本、忽略规则或框架替换，并将在项目内记录复核期限与触发条件。

## Verification Notes

- 入口：HEAD `228de77b97e42e8b571871048c425ebd5712cbc0`，detached clean；Node `v24.19.0`、pnpm `11.9.0`；权限 unrestricted / approval never。
- release manifest stdout SHA-256 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`；5 migrations、35 commands、29 resources、generation 2、legacy writer incompatible。
- legacy GET 定向测试 2/2；ESLint 基线 0 errors / 102 warnings（94 unused、8 Hooks）；audit prod 0，全树 0 Critical / 14 High / 8 Moderate / 3 Low。
- MySQL/D1 SQL、journal、snapshot 逐文件 SHA-256 已在任务入口冻结，最终须逐字重比。
- 已完成四个线性提交：source snapshot `4dccab8`、薄 410 shim `56647d3`、Hooks/ESLint `2fb52e5`、migrator allowlist `bbed0f0`；当前 worktree clean。
- snapshot 验证 18 routes / 184,320 bytes / sensitive clean / runtime-build-lint-Docker-release closure excluded；legacy/R3 定向合同 10/10，Web system 4/4。
- ESLint 当前 0 errors / 0 warnings；Hooks 生命周期 3/3，覆盖 14 个 cleanup abort、toast callback identity 不触发重复初始请求、慢 tier 1 不覆盖快 tier 2。
- deploy/release/rollback 定向门 30/30；标准化 migrator 无 `env_file`，环境精确为 `DATABASE_URL`、`DB_SSL`、`DB_SSL_REJECT_UNAUTHORIZED`。
- release manifest hash 仍为 `50225ce...c94bc`，相对 accepted T1 的 migration/release manifest 路径 diff 为空；prod audit 0，全树仍 0 Critical / 14 High / 8 Moderate / 3 Low。
- 两个独立只读质询与主写者 registry 复核一致：`image-size` latest `2.0.2` 且无 `2.0.3`；Vinext 当前 `0.0.50` 与 latest `1.0.0-beta.5` 都精确依赖 `2.0.2`；两项 High 要求 `>=2.0.3`。用户已裁决将其作为唯一上游例外继续 Stage 9 T2。
- ESLint 依赖簇以四个限定 major 的 override 修复 `brace-expansion` 与 `js-yaml` 六项 High；lint 与 baseline 均为 0 errors / 0 warnings，提交 `72ab929`。
- Wrangler/Undici 簇使用首个通过 24 小时供应链年龄门的正式顶层组合 `@cloudflare/vite-plugin@1.51.1`、`wrangler@4.120.0`；其精确闭包为 `miniflare@5.20260801.1-alpha -> undici@7.29.0`、`esbuild@0.28.1`。未保留安装器建议的发布年龄例外。Web typecheck、preview 46 routes、system 4/4 通过；全树降至 0 Critical / 4 High / 2 Moderate / 0 Low，生产仍为 0。
- Vinext/Vite/RSC 簇只升级 `vite 8.0.13 -> 8.0.16` 与 React/ReactDOM/RSC 同步 `19.2.6 -> 19.2.8`；Vinext 和 `@vitejs/plugin-rsc` 保持冻结。Web typecheck、preview 46 routes、Next 47/47、system 4/4 通过。
- `audit:policy` 保留原生 full-tree audit 的非零结果，同时强制生产 audit 全零、Critical=0、High 精确且仅为两条 dev-only `image-size@2.0.2` 例外。例外在 `2026-09-12` 到期，或遇 image-size 正式修复、Vinext 依赖变化、advisory/输入面变化时提前复核。当前全树为 0 Critical / 2 High / 1 Moderate / 0 Low。
- Drizzle/esbuild 簇将 `@esbuild-kit/core-utils` 的 `esbuild@0.18.20` 精确 override 到首个真实发布且不在 advisory vulnerable range 的 `0.25.0`；advisory 声称的 `0.24.3` 并未在 npm 发布，未虚构版本。隔离 migration 副本上的 `drizzle-kit generate` 报告无 schema 变化，仓库 22 个 migration/journal/snapshot 文件哈希不变，冻结历史 19/19 通过。全树现为 0 Critical / 2 adjudicated High / 0 Moderate / 0 Low，生产全零。
- Batch 6 将 XLSX 从首屏静态 import 改为尺寸与扩展名校验后的按需 import，并将两个 `cloudflare:workers` import 改为相同字面 specifier。preview build 的项目可控 large-chunk 与 dynamic-import warning 均归零；page chunk 从 544,818 bytes 降至 181,718 bytes，XLSX 为 manifest 标记的独立 dynamic entry 493,280 bytes。Web typecheck、build boundary 6/6、system 4/4 通过。
- 剩余第三方/环境提示精确为：(1) `wrangler@4.120.0/wrangler-dist/cli.js:432180` 检测到当前代理环境并告知 fetch 将使用代理，不清除 proxy 以免改变网络语义；(2) `vinext@0.0.50/dist/build/report.js:614` 对 `/` 输出 Unknown，源码明确其静态分析无法识别 dynamic API，Next 同页 47/47 构建精确判为 static。不添加 `dynamic`/`revalidate` 来规避提示，以免改变缓存语义。
- 完整 non-MySQL 门首次发现 7 条测试仍从已退役 legacy route 读取安全实现；测试已迁到 R3 successor handler，同时保留 legacy successor shim 断言，未改业务源码。完整门为 54 files / 357 tests / 0 skip，Web system 4/4。
- 真实 MySQL 8.4 门使用 loopback-only 临时容器和四个精确测试库，不读取生产凭据；8 files / 21 tests / 0 skip 全绿，覆盖 platform/R2/R3、事务并发、Worker replay/fence、fresh install、migration upgrade/repeat/divergent lineage 与 rollback。唯一临时容器 `stage9-t2-mysql-9cfb` 已删除。
