# Implementation Notes

## Source

- 用户明确认为当前结构尚未完成真正的前后端分离，并批准 `stage9-physical-separation-orchestration-plan.md` 的三阶段长期拓扑快速推进。
- 生产基线为 `364aeb186ee79468b473a4f17689c2991e2b2fe3`；本文件和计划文档先形成 docs-only 审计提交，生产基线语义不变。

## Design Decisions

- 使用 T1 物理分包、T2 质量债务、T3 只读验收三个串行用户可见结果所有者；任一时刻只允许一个项目写者和一个活动实现 worktree。
- 路径搬迁高度重叠，不用多个并行写者硬提速；每个结果所有者可使用最多两个内部只读 Agent 提供路径、安全、依赖和兼容证据。
- `apps/web` 搬迁与根目录所有权在 T1 同一结果中完成，避免对路径、package、Docker 和测试做两轮重复改写。
- legacy 410 路由与不可达旧主体分开裁决：保留兼容壳，旧主体在形成项目内受控 source snapshot 后退出 live source。

## Deviations

- 已批准方案原口头基线为 `364aeb1`；实际 T1 将从该生产基线之上的 docs-only 计划提交启动，使执行任务可直接读取正式结果合同。该差异不改变任何生产文件、依赖、lock、SQL 或运行行为。

## Tradeoffs

- 串行写者降低路径冲突和重复集成成本，速度主要通过阶段内只读并行、自动阶段切换和 20 分钟最大静默取得。
- 全依赖 High=0 可能受 Vinext 上游限制；不为达成数字静默替换框架，遇到实质路线变化返回用户裁决。
- 原始资产保留优先于机械减 LOC，但 archive/source snapshot 必须从 runtime、build、lint、Docker 和发布闭包隔离。

## Open Questions

- 无当前阻塞问题。只有 Vinext 安全升级需要换框架、Sites 根约定无法兼容迁移或其他冻结边界必须改变时返回用户。

## Verification Notes

- 当前主任务已存在 `主-` 标记；项目为 Git repository，Codex Desktop 支持用户可见 worktree任务、读取、等待、归档与 heartbeat automation。
- 计划文档提交后核对 Git diff 仅包含两份 `docs/refactor` 文档，再从该提交创建 T1。
