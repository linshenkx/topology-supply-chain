# Scope A 真人与 Agent E2E 验收手册

本目录提供当前 Scope A / Stage 12 的自动化基线、受控测试环境、业务场景、真人 UAT 和证据模板。Agent 只是可选执行者；使用几个 Agent、是否并发、采用哪种浏览器或模型，均由一次测试计划决定，不属于仓库长期验收合同。

> 术语说明：R2/R3 沿用 Scope A 写迁移历史代号（R2=供应侧，R3=履约财务侧）；代码已改用领域名 supply/operations，冻结命令名与 writer resource 不变。功能代码锚点为 `254e3a0de1a3ef812c7487550f1ae7d8d0e7a61a`；实际运行必须记录 `git rev-parse HEAD`，并与 `e2e:status.repositorySha` 一致。

## 执行入口

1. 运行 [Tier 0 自动化基线](./tier0-automation.md)。
2. 使用唯一 `RUN_ID` 创建受控 loopback 环境，并通过 [Tier 1 就绪门](./tier1-readiness.md)。
3. 自动化或 Agent 执行者遵守 [Agent 执行规程](./agent-execution.md)；真人按 [真人执行规程](./human-execution.md) 操作。
4. 以 [覆盖矩阵](./coverage-matrix.md) 确认已实现、需人工检查、演示和超范围内容，按 [Scope A 场景清单](./scope-a-scenarios.md) 与 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md) 执行。
5. 运行证据遵守 [证据要求](./governance/evidence-protocol.md)，问题按 [结果与严重度规则](./governance/verdict-severity-and-continuation.md) 记录，并填写 [UAT 签字模板](./templates/uat-signoff.md)。

## 执行原则

- 自动化已经覆盖的幂等、非法输入、权限和数据库合同不要求在浏览器中逐项重复；浏览器主要验证真实页面操作、状态反馈和关键业务链。
- 使用一个经过验证的受控环境串行执行即可；任务数、Worktree、浏览器隔离和模型分配不是验收门槛。
- 测试载体无法运行时记录为 `BLOCKED` 或 `NOT_RUN`，不得据此判定产品功能 `FAIL`。
- Blocker 停止受影响业务链；Major、Minor 和 Observation 按规则登记。非阻断问题只记录，不在验收任务中顺手修改代码。
- 每条关键业务链保留必要步骤、3–5 张代表性截图和至少一种 API/DB/audit/outbox 证据；不为证据格式本身重复执行测试。

## 长期文档

| 文件 | 用途 |
| --- | --- |
| [coverage-matrix.md](./coverage-matrix.md) | 角色、模块、页面、场景及当前自动化/人工检查边界 |
| [stable-ids.md](./stable-ids.md) | 角色、模块、旅程和场景的稳定标识 |
| [scope-a-scenarios.md](./scope-a-scenarios.md) | 场景步骤与判定 |
| [stage12-human-business-acceptance.md](./stage12-human-business-acceptance.md) | 三条业务闭环的真人浏览器/UAT 手册 |
| [tier0-automation.md](./tier0-automation.md) | Tier 0 自动化基线 |
| [tier1-readiness.md](./tier1-readiness.md) | Tier 1 环境、fixture 和认证就绪门 |
| [agent-execution.md](./agent-execution.md) | 自动化/Agent 执行规程 |
| [human-execution.md](./human-execution.md) | 真人执行规程 |
| [request-templates.md](./request-templates.md) | R2/R3 请求与 DB 证据模板 |
| [governance/evidence-protocol.md](./governance/evidence-protocol.md) | 最低证据与脱敏要求 |
| [governance/verdict-severity-and-continuation.md](./governance/verdict-severity-and-continuation.md) | 结果、问题严重度和继续/停止规则 |
| [templates/](./templates/) | fixture、evidence、issue 和 signoff 模板 |

## 环境和范围边界

- 只允许 loopback 服务、临时测试数据和受控 MySQL 8；不得连接生产、使用生产凭据、调用真实 provider、部署或 push/PR。
- Web/API/Worker origin 只从当前 `RUN_ID` 的 `e2e:status` 读取，禁止手写端口。
- 证据写入 Git 忽略目录 `delivery/agent-uat/<RUN_ID>/`，不得保存密码、Cookie、OTP、CSRF、AccessKey 或数据库凭据。
- Stage 12 已实现并应验收：整批收货、整批质检放行/隔离、生产真实预留/领料消耗/释放剩余预留。
- 仍超范围：部分收货、冲销、供应商退货、MRP/多批次/替代补退料/排产、拆批/部分放行/复检/让步/返工报废/成本责任、完整 MES/ERP/税务/银行/实时物流、工厂协同大屏、生产级 AI、真实 provider 和生产部署。
