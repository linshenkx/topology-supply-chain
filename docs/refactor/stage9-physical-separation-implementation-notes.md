# Implementation Notes

## Source

- 用户明确认为当前结构尚未完成真正的前后端分离，并批准 `stage9-physical-separation-orchestration-plan.md` 的三阶段长期拓扑快速推进。
- 生产基线为 `364aeb186ee79468b473a4f17689c2991e2b2fe3`；本文件和计划文档先形成 docs-only 审计提交，生产基线语义不变。

## Design Decisions

- 使用 T1 物理分包、T2 质量债务、T3 只读验收三个串行用户可见结果所有者；任一时刻只允许一个项目写者和一个活动实现 worktree。
- 路径搬迁高度重叠，不用多个并行写者硬提速；每个结果所有者可使用最多两个内部只读 Agent 提供路径、安全、依赖和兼容证据。
- `apps/web` 搬迁与根目录所有权在 T1 同一结果中完成，避免对路径、package、Docker 和测试做两轮重复改写。
- legacy 410 路由与不可达旧主体分开裁决：保留兼容壳，旧主体在形成项目内受控 source snapshot 后退出 live source。
- T1 只抽取两个已有真实跨运行时消费者的 primitive：运行环境判定与 MySQL ISO 日期时间归一化；不建立通用 shared、repository、domain 或 CQRS 包。
- `.openai/hosting.json` 继续保留根目录，作为 Sites 工具约定的唯一根目录例外；`apps/web/vite.config.ts` 以显式相对路径读取它。

## Deviations

- 已批准方案原口头基线为 `364aeb1`；实际 T1 将从该生产基线之上的 docs-only 计划提交启动，使执行任务可直接读取正式结果合同。该差异不改变任何生产文件、依赖、lock、SQL 或运行行为。
- 隔离 Git worktree 不复制 343 项 ignored archive 实体，因此本 worktree 只能冻结并复核 tracked manifest；资产 `verify` 与 `restore-dry-run` 必须在同 SHA 的资产 owner checkout 复核，不能把缺失实体报告为通过。

## Tradeoffs

- 串行写者降低路径冲突和重复集成成本，速度主要通过阶段内只读并行、自动阶段切换和 20 分钟最大静默取得。
- 全依赖 High=0 可能受 Vinext 上游限制；不为达成数字静默替换框架，遇到实质路线变化返回用户裁决。
- 原始资产保留优先于机械减 LOC，但 archive/source snapshot 必须从 runtime、build、lint、Docker 和发布闭包隔离。

## Open Questions

- 无当前阻塞问题。若 `apps/web` 下的 Vinext/Sites、Next standalone tracing 或 Docker context 无法通过纯路径修复保持兼容，则停止并返回主任务裁决。

## Verification Notes

- 当前主任务已存在 `主-` 标记；项目为 Git repository，Codex Desktop 支持用户可见 worktree任务、读取、等待、归档与 heartbeat automation。
- 计划文档提交后核对 Git diff 仅包含两份 `docs/refactor` 文档，再从该提交创建 T1。
- T1 入口门禁：`HEAD=36fe95f1b2d3725616a0e2e62ef863078086adef`，父提交为生产语义基线 `364aeb186ee79468b473a4f17689c2991e2b2fe3`；入口 detached、clean，Node `v24.19.0`、pnpm `11.9.0`，权限为 unrestricted / approval never，tracked 根一级条目为 40。
- 原生 Goal 已创建并保持 active，绑定任务 `019ff8cc-6bfd-7e43-b7fa-b8deac7247dc`；工作分支为 `codex/stage9-web-physical-separation`。
- 冻结 release manifest：原生 stdout 10,833 bytes，SHA-256 `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc`；5 migrations、35 commands、29 resources、writer generation 2、`legacyWriterCompatible=false`。
- 冻结 identity 子集 SHA-256：commands `4befa44353557a7565427d3b5c49106024bc5c05badb318db969c2a1e21b59e0`，resources `6e62093cccb772b6d9913040b3cbcfc24a063ecdc51a7e5d50702cf357a0b542`，migrations `c54e55a41aa786d28662b04aaa4c3814d2e0a830ef8c14239d3ced1973e25e15`。
- MySQL migration SQL SHA-256：0000 `7d881b148166d64865a3062ff36898888eeef9c5f87fb650f9533c27fb576f7c`；0001 `425efc9f6fd7baa04a80bd6bc03a39716201af5916ae9a62c103e098f52e1577`；0002 `8d2878f9b5e2068343db0d12437b2d92a479cbcb23e0dc668d1395ba703a2a64`；0003 `f7fb8dcf1ff6185cebd866a39836b0c5ef7b56a7e96ccc8fe438aa572b96df41`；0004 `974aefb885e265e082f4f1a6006b2cd77472cf63183ca1746d0fc83885bf9ecd`。MySQL journal hash 为 `63a4e0bd06c2291ed720e582058d3b983bb2356d8fd9b130132333564c80985f`。
- legacy compatibility 基线为 18 条受合同测试约束的 `410 + WRITER_MOVED + successor Link`；archive tracked manifest 为 `archived` 343/343，实体只存在于 owner checkout。
