# Implementation Notes

## Source

- 用户委派的 Stage 9 T2 合同：仅从 accepted T1 SHA `228de77b97e42e8b571871048c425ebd5712cbc0` 清零非业务质量与安全债务，冻结业务语义、公共 API、权限、Schema、migration 字节与持久化 identity。
- 上位计划为 `docs/refactor/stage9-physical-separation-orchestration-plan.md` 第 5 节；本任务是唯一项目写者并使用原生 Goal。

## Design Decisions

- 18 个退役 route 的 accepted-T1 完整源码保存为确定性 tar source snapshot；manifest 记录原路径、successor、字节数、SHA-256 和 snapshot member，验证器同时执行敏感扫描、closure 断言与逐字 restore dry-run。
- source snapshot 放在既有 `archive/` 所有权下并显式保持 lint、TypeScript、Docker、构建和发布闭包之外；live route 只保留逐方法薄 `retiredPlatformRoute` shim。

## Deviations

- 无。

## Tradeoffs

- 使用标准 tar 而非新建通用归档包，保持可移植恢复证据并避免把历史 TypeScript 重新纳入工具链。
- 依赖簇严格串行；Vinext/Vite/RSC 若只能通过框架替换或业务变化消除 High，将停止并请求裁决。

## Open Questions

- 无当前阻塞问题。

## Verification Notes

- 入口：HEAD `228de77b97e42e8b571871048c425ebd5712cbc0`，detached clean；Node `v24.19.0`、pnpm `11.9.0`；权限 unrestricted / approval never。
- release manifest stdout SHA-256 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`；5 migrations、35 commands、29 resources、generation 2、legacy writer incompatible。
- legacy GET 定向测试 2/2；ESLint 基线 0 errors / 102 warnings（94 unused、8 Hooks）；audit prod 0，全树 0 Critical / 14 High / 8 Moderate / 3 Low。
- MySQL/D1 SQL、journal、snapshot 逐文件 SHA-256 已在任务入口冻结，最终须逐字重比。
