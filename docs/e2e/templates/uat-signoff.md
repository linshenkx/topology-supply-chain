# UAT 结果与签字模板（Stage 12 业务闭环）

本模板是可填写的副本，不重复主手册内容。复制为 .\delivery\agent-uat\<RUN_ID>\signoff.md 后填写；签字前确认 git status --short 干净、repositorySha 与 git rev-parse HEAD 一致、证据位于 gitignored 目录、未落盘任何秘密。

## 运行信息

| 字段 | 值 |
| --- | --- |
| RUN_ID | <RUN_ID> |
| 功能代码锚点 | 254e3a0de1a3ef812c7487550f1ae7d8d0e7a61a（docs-only 后代链，不是实际执行 SHA） |
| repositorySha | <git rev-parse HEAD>（必须等于 <e2e:status.repositorySha>） |
| fenceProfile | t2-operations-scope-a-closures |
| HTTPS origin | <e2e:status.origins.https> |
| fixtureManifestSha | <e2e:status.fixtureSha> |
| 执行时间 | <ISO-8601 起止> |

### S12-C 双 RUN_ID 记录（C1 与 C2 独立执行）

默认 fixture 只有一个 executionOrderId：C1（reserve→materials→release）与 C2（reserve→materials→complete，不先 release）必须使用两个独立 RUN_ID，各自 prepare/start/status/evidence/stop/cleanup；repositorySha、fenceProfile、HTTPS origin 读取规则相同。只有环境管理员额外提供第二个 execution order 时才可在同一 RUN_ID 内继续 C2。

| 检查点 | S12-C1 | S12-C2 |
| --- | --- | --- |
| RUN_ID | <S12-C1-RUN_ID> | <S12-C2-RUN_ID> |
| repositorySha | <git rev-parse HEAD> | <git rev-parse HEAD> |
| HTTPS origin | <e2e:status.origins.https> | <e2e:status.origins.https> |
| 证据路径 | .\delivery\agent-uat\<S12-C1-RUN_ID> | .\delivery\agent-uat\<S12-C2-RUN_ID> |
| 清理状态 | complete/not-needed/blocked | complete/not-needed/blocked |

## 场景结果

每行结果只允许 PASS / PASS_WITH_ISSUES / FAIL / BLOCKED / HUMAN_CHECKPOINT / NOT_RUN / NOT_APPLICABLE / NEEDS_DECISION。PASS 必须附证据路径；BLOCKED/HUMAN_CHECKPOINT 必须写原因与交接对象；FAIL 必须保留首个失败响应与日志。禁止用 skip 冒充 PASS。

| 场景ID | 页面/业务链 | 操作者角色 | 执行方式 | 结果 | 证据路径 | 备注/未覆盖原因 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 登录/OTP/Step-up/范围 | admin/supply_chain/denied | UI+API+DB | | | |
| A2 | 审批批准/拒绝/重放 | approver | UI+API+DB | | | |
| S12-A | 采购单→整批收货→待检批次 | supply_chain/factory | UI+API+DB | | | |
| S12-B | 待检批次→整批质检→放行/隔离 | admin（inspectorType=company_qc） | UI+API+DB | | | company_qc/supplier_qc 无 fixture 账号时 HUMAN_CHECKPOINT |
| S12-C1 | 生产预留→领料/消耗→释放（C1，独立 RUN_ID） | supply_chain/factory | UI+API+DB | | | 连续浏览器证据仅覆盖 reserve→materials→release；RUN_ID 见上表 |
| S12-C2 | 生产完工 complete（C2，独立 RUN_ID，不先 release） | supply_chain/factory | UI+API+DB | | | reserve→materials→complete；不与 C1 冒充同一连续浏览器链 |
| R2 | 主数据/供应商/采购/导入 | supply_chain/factory | API 优先+UI | | | |
| R3 | 库存/调拨/盘点/生产/质检/发货/退货/财务 | supply_chain/factory/finance | API 优先+UI | | | |
| P1/P2 | 幂等/fence/unknown/audit/outbox | 任意 | API/DB/Worker | | | |
| C1/C2 | 旧 GET 410 / OSS 缺失 503 | 环境管理员 | API/受控配置 | | | |

## NO-GO / 阻断说明

- 是否出现 NO-GO：是/否
- repositorySha 是否等于 git rev-parse HEAD：是/否
- 阻断项与证据：
- 是否已清理：complete / not-needed / blocked（附责任人）

## 签字

| 角色 | 姓名 | 签字 | 日期 | 结论 |
| --- | --- | --- | --- | --- |
| 业务验收人 | | | | GO / NO-GO |
| 测试操作者 | | | | |
| 环境管理员 | | | | |
| 结果所有者（主任务裁决） | | | | |

> 本模板记录实际 repositorySha（git rev-parse HEAD，且等于 e2e:status.repositorySha）；功能代码锚点为 254e3a0。历史 Stage 10/11 报告不改写，且不将演示看板（工作台/工厂协同/AI助手）作为通过项。
