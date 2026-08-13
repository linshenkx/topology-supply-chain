# Implementation Notes

## Source

- 用户委派的 Stage 9 T2 合同：仅从 accepted T1 SHA `228de77b97e42e8b571871048c425ebd5712cbc0` 清零非业务质量与安全债务，冻结业务语义、公共 API、权限、Schema、migration 字节与持久化 identity。
- 上位计划为 `docs/refactor/stage9-physical-separation-orchestration-plan.md` 第 5 节；本任务是唯一项目写者并使用原生 Goal。

## Design Decisions

- 18 个退役 route 的 accepted-T1 完整源码保存为确定性 tar source snapshot；manifest 记录原路径、successor、字节数、SHA-256 和 snapshot member，验证器同时执行敏感扫描、closure 断言与逐字 restore dry-run。
- source snapshot 放在既有 `archive/` 所有权下并显式保持 lint、TypeScript、Docker、构建和发布闭包之外；live route 只保留逐方法薄 `retiredPlatformRoute` shim。

## Deviations

- 任务在依赖批次的 Vinext/Vite/RSC 簇前按合同暂停：正式上游不存在 `image-size >=2.0.3`，无法在不分叉上游或改变框架路线的条件下达到全树 High=0。

## Tradeoffs

- 使用标准 tar 而非新建通用归档包，保持可移植恢复证据并避免把历史 TypeScript 重新纳入工具链。
- 依赖簇严格串行；Vinext/Vite/RSC 若只能通过框架替换或业务变化消除 High，将停止并请求裁决。

## Open Questions

- 需要用户裁决：等待 `image-size`/Vinext 正式修复，或另行授权极窄上游分叉及恶意 ICNS/JXL/HEIF hang 回归；当前授权不允许静默 override、patch-package、Git fork 或换框架。

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
- 两个独立只读质询与主写者 registry 复核一致：`image-size` latest `2.0.2` 且无 `2.0.3`；Vinext 当前 `0.0.50` 与 latest `1.0.0-beta.5` 都精确依赖 `2.0.2`；两项 High 要求 `>=2.0.3`。
