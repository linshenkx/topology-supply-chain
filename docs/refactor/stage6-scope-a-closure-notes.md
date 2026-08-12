# Stage 6 Scope A Closure Notes

## Wave 1：MySQL migration历史与可重复工程基线

- 本地Git证据显示`0000`/`0001`在初始提交后被原地改写；没有发现生产数据库或生产凭据证据，未推断生产已应用状态。
- MySQL 8.4.11 oracle确认初始`0000`在首个外键处因`SERIAL`主键的`BIGINT UNSIGNED`与引用列`INT`不兼容而失败，Drizzle不会记录完成history。因此冻结当前可完整执行的`0000`至`0004`为唯一canonical manifest，不承诺兼容初始hash，也不修改`__drizzle_migrations`冒充历史。
- preflight现同时冻结SQL/snapshot hash、journal顺序/时间戳，并要求数据库history为`hash + created_at`严格前缀；非空无history、未知/初始hash、时间戳错位和额外history均fail closed。
- `@alicloud/openapi-core`的`allowBuilds`已明确设为`false`；该纯JavaScript SDK不获准运行安装构建脚本，frozen install无需lockfile变化。
- 生产门禁仍要求数据库负责人只读导出并核对真实ordered history；本任务没有连接生产数据库、读取生产凭据或改写生产history。

## Wave 1 — legacy GET boundary closure (2026-08-12)

- Exact baseline: `a4b929530c0ebfa3c008adc13161f32c80dd7063` in an isolated, initially clean worktree.
- Recursive enumeration found 18 non-v1 business GET routes with independent Next DB/authorization logic after excluding health, session, already-retired platform GETs, and the development-only v1 bridge. All 18 now return the shared 410 response with an `/api/v1` successor; repository production consumers already use `/api/v1`, so no legacy business adapter was retained.
- Fastify shipments now applies receiver destination or factory ownership scope in SQL before `ORDER BY ... LIMIT 200`; internal access remains organization-wide and post-query relation/visibility checks remain fail-closed. Receiver authorization still relies on the existing trimmed organization-name equality and requires business adjudication before any Receiver/LegalEntity model change.
- Verification covers recursive 18→0 source enumeration, supplier QC isolation, missing factory bindings, external scope-before-LIMIT starvation, the v1 frontend boundary, full Fastify API tests, frontend production build, and live local HTTP 410 successor responses. No migration, workspace/lock, deployment, command executor, R2/R3 write, or business-state-machine semantics were changed.
- Repository evidence cannot establish external callers or production traffic. Unidentified callers now fail closed with 410 and must migrate to `/api/v1`.

## 2026-08-12 — Wave 2 release activation and rollback safety closure

- Exact implementation baseline: `c794c1c21de90053fdb81f5b9d0e79196117c3d4` in an isolated, initially clean linked worktree.
- Ordinary `deploy.sh` no longer invokes `set-writer-fences.mjs`; it installs one Web/API/Worker/migrator tag, validates configuration and canonical append-only migration history, drains before migration, starts and probes all runtimes, and records the image-produced release manifest. Automatic writer activation is therefore the requested/audit metric `31 -> 0`; direct baseline enumeration finds 29 distinct resource values (the prior script has 31 dotted string literals only when its two SQL strings are also counted), and the executable deploy path now activates 0 in either count.
- Writer activation is a separate explicit allowlist flow. It binds a non-empty resource list to hashed release/wave/drain/reconciliation/approval/observability evidence, validates canonical resource owner/generation identity, repeats live drain checks, locks selected fences, and commits only the requested resources. Invalid empty/unknown/duplicate lists or evidence/reconciliation/drain failures make zero changes; a repeated successful wave is idempotent.
- The release manifest is the rollback contract: exact schema lineage, writer generation, all canonical command-to-resource identities, runtime services, release family, and minimum compatible manifest/release sequence. Rollback never infers compatibility from Worker image presence, never permits a legacy override, and always runs the active release checker against database migration history, active fences, and all distinct command facts. The former handwritten rollback command allowlist is `10 -> 0` entries; incompatible/pre-Scope-A/missing manifests fail closed and require forward-fix.
- No business handler, contract, command runtime, migration SQL/meta, legacy GET, root package/lock, command executor, production credential, deployed environment, or irreversible database state was changed by this task.
- Final bounded review revision separates Worker install readiness from execution authorization: disabled generation-2 Worker fences with correct identities are a ready/paused state, while every claim and side-effect path retains its existing `enabled=1` fence check. Missing or wrong owner/generation remains not-ready.
- The five canonical MySQL migration declarations now live only in `scripts/mysql-migration-manifest.mjs`, including SQL and snapshot hashes. Both database preflight and release-manifest output invoke the same repository validator before DB access/output; tests reject declaration omissions/timestamps/digests/names/duplicates and SQL/snapshot/journal idx/tag/when/version/breakpoint drift.
