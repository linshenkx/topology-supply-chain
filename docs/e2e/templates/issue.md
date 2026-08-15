# 问题 ISS-<RUN_ID>-NNN

| 字段 | 值 |
| --- | --- |
| 问题 ID | ISS-<RUN_ID>-NNN |
| 场景 ID | <A1/R2/S12-A/...> |
| 覆盖项 | <SLICE-ID，可选> |
| 严重度 | Blocker / Major / Minor / Observation / NeedsDecision |
| 结果状态 | <PASS / PASS_WITH_ISSUES / FAIL / BLOCKED / HUMAN_CHECKPOINT / NOT_RUN / NOT_APPLICABLE / NEEDS_DECISION> |
| 操作者角色 | <ROLE-KEY> |
| 业务模块 | <MOD-KEY> |
| RUN_ID | <RUN_ID> |
| repositorySha | <git rev-parse HEAD> |
| 报告时间 | <ISO-8601> |

## 复现步骤

1. <精确步骤>

## 预期

- <明确预期>

## 实际

- <实际观察；附截图路径、HTTP 状态、DB/audit/outbox 证据路径>

## 处置

- [ ] record（非阻塞：只记录，不修）
- [ ] block（Blocker：停止该链/该 RUN，保存证据并交给验收负责人）
- [ ] escalate（业务语义不明确：needs_decision，不做缺陷定级）

## 证据

- steps: <delivery/agent-uat/<RUN_ID>/steps.md>
- screenshot: <delivery/agent-uat/<RUN_ID>/ui/>
- http/db/audit/outbox: <delivery/agent-uat/<RUN_ID>/{api,db,logs}/>

> Minor/Observation/NeedsDecision 只登记。Blocker/Major 是否修复由项目负责人另行裁决，验收执行者不得顺手修改生产或测试代码。
