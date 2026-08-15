# UAT 结果与签字模板（Stage 12 业务闭环）

本模板是可填写的副本，不重复主手册内容。复制为 /e2e-runtime/evidence/<RUN_ID>/signoff.md 后填写；签字前确认 git status --short 干净、证据位于 gitignored 目录、未落盘任何秘密。

## 运行信息

| 字段 | 值 |
| --- | --- |
| RUN_ID | e2e-YYYYMMDD-HHMMSS-xxxx |
| repositorySha | 254e3a0de1a3ef812c7487550f1ae7d8d0e7a61a |
| fenceProfile | t2-operations-scope-a-closures |
| HTTPS origin | https://127.0.0.1:<status.origins.https> |
| fixtureManifestSha | <e2e:status.fixtureSha> |
| 执行时间 | <ISO-8601 起止> |

## 场景结果

每行结果只允许 pass / fail / blocked / human-checkpoint / not-applicable。pass 必须附证据路径；blocked/human-checkpoint 必须写原因与交接对象；fail 必须保留首个失败响应与日志。

| 场景ID | 页面/业务链 | 操作者角色 | 执行方式 | 结果 | 证据路径 | 备注/未覆盖原因 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 登录/OTP/Step-up/范围 | admin/supply_chain/denied | UI+API+DB | | | |
| A2 | 审批批准/拒绝/重放 | approver | UI+API+DB | | | |
| S12-A | 采购单→整批收货→待检批次 | supply_chain/factory | UI+API+DB | | | |
| S12-B | 待检批次→整批质检→放行/隔离 | company_qc/admin | UI+API+DB | | | |
| S12-C | 生产预留→领料/消耗→释放→完工 | supply_chain/factory | UI+API+DB | | | |
| R2 | 主数据/供应商/采购/导入 | supply_chain/factory | API 优先+UI | | | |
| R3 | 库存/调拨/盘点/生产/质检/发货/退货/财务 | supply_chain/factory/finance | API 优先+UI | | | |
| P1/P2 | 幂等/fence/unknown/audit/outbox | 任意 | API/DB/Worker | | | |
| C1/C2 | 旧 GET 410 / OSS 缺失 503 | 环境管理员 | API/受控配置 | | | |

## NO-GO / 阻断说明

- 是否出现 NO-GO：是/否
- 阻断项与证据：
- 是否已清理：complete / not-needed / blocked（附责任人）

## 签字

| 角色 | 姓名 | 签字 | 日期 | 结论 |
| --- | --- | --- | --- | --- |
| 业务验收人 | | | | GO / NO-GO |
| 测试操作者 | | | | |
| 环境管理员 | | | | |
| 结果所有者（主任务裁决） | | | | |

> 本模板只记录当前基线（254e3a0）的真人验收事实；历史 Stage 10/11 报告不改写，且不将演示看板（工作台/工厂协同/AI助手）作为通过项。
