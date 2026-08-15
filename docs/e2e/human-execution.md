# 真人执行规程

本规程由业务验收人、测试操作者和环境管理员共同执行。它是 Tier 1：先完成[环境与 fixture 就绪门](./tier1-readiness.md)和 Tier 0，缺少经授权受控环境、测试角色、HTTPS 会话条件或可清理测试数据即记录 `BLOCKED`，不要使用生产账户或数据替代。

功能代码锚点为 `254e3a0`（Stage 12 业务闭环），本 docs/e2e 是其 docs-only 后代；实际 repositorySha 以 git rev-parse HEAD 为准并等于 e2e:status.repositorySha。三条闭环的逐页面必验步骤与签字以 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md) 为准。

## 开始前

1. 记录 `RUN_ID`、Git SHA、环境 URL、执行时间和操作者；确认 URL 为 loopback 或书面授权的测试环境。
2. 准备互不重叠的测试身份：组织管理员、工厂/供应链操作者、审批人、财务角色和无权角色。当前 fixture 只生成 admin/supply_chain/factory/approver/finance/denied，账号格式为 `<role>.<RUN_ID>@e2e.invalid`；独立 company_qc/supplier_qc 账号不在 fixture，需环境管理员额外授权，否则该身份 human-checkpoint/BLOCKED。测试组织、工厂、供应商、SKU、仓库、批次和单据的名称均加 `E2E-<RUN_ID>-` 前缀。
3. 环境管理员确认可查看测试库中本次前缀的数据、`audit_logs` 与 `outbox_messages`，并确认 Worker 使用 stub/受控 webhook，非真实 provider。
4. 从 `pnpm e2e:status -- --run $env:RUN_ID` 的 `origins.https` 读取本次随机 HTTPS 同源入口，以浏览器打开该地址；不得固定使用 `http://127.0.0.1:3000` 或绕过 Secure Cookie。API/Worker 内部 origin 与随机端口同样以 status/manifest 为准。页面当前没有面向所有场景的稳定 selector；每个 UI 步骤均是人工检查点，API/DB 证据才是可重复替代路径。

## 通用操作和取证

每个写动作按以下顺序进行：

1. 在 UI 记录页面、可见角色、表单输入和提交前截图；或调用[场景清单](./scope-a-scenarios.md)给出的 v1 API。保存脱敏的请求摘要与 HTTP 状态。
2. 成功响应必须包含或能关联到 command identity、idempotency key、request digest 和 `replayed`。R2/R3 command response 的 `replayed: false` 是首次完成的预期；同一请求重放后才允许为 `true`。
3. 查询或由环境管理员截图确认：业务记录仅属于本次 `RUN_ID`；对应 `audit_logs` 有 actor/action/entity/时间；对应 `outbox_messages` 有同一业务关联和可解释状态。未定义精确业务字段时，记录实际字段，不自行推导状态机。
4. Worker 场景记录其健康、处理日志和消息前后状态。遇到失败、重复或 lease/fence 争议，停止该场景并保留证据；不得直接改表把消息标为完成。

失败判定：HTTP 非预期、越权却成功、相同请求无法重放、换 digest 未被拒绝、写入无审计/Outbox、数据越出组织/工厂范围、响应泄露凭据，均为 NO-GO 候选。`401/403/409/503` 只有在该负向路径被场景明确期望时才可能是通过。

## UI 人工检查点

- 登录/OTP/Step-up：确认 UI 不显示 OTP 或会话秘密；Step-up 明确对应当前审批或财务对象，失效或换对象后不能复用。
- 主数据、采购、库存、调拨、盘点、生产/质检、发货/退货、财务：确认列表和详情只显示该角色/组织/工厂应见范围；提交后记录页面通知或错误文案，但以 API/DB 为最终事实。
- 整批收货：采购单明细只显示唯一权威收货仓库；确认后提示“已整批收货，进入待检批次”，刷新后“已收货”且待检批次出现该批次。
- 整批质检：待检批次只对 admin/company_qc 可操作；整批合格提示转入可用、整批不合格提示转入隔离；刷新后批次从待检列表消失，最近质检出现 passed/failed。
- 生产预留/领料/释放：物料实绩保存、释放剩余预留提示必须与刷新后的生产单状态、库存批次与审计/Outbox 一致；零预留或重复释放要能观察到稳定失败提示。生产完工 complete 是独立人工检查点：C1（reserve→materials→release）与 C2（reserve→materials→complete，不先 release）使用两个独立 RUN_ID（默认 fixture 只有一个 executionOrderId）；C2 在独立 run 内完成且不先 release，不能把已 release 的单继续报正数领用/完工。仅当环境管理员额外提供第二个 execution order 时才可同 run 继续。
- 导入：人工核对 preview、stage、commit 是三个独立动作；上传人/导入归属不匹配应被拒绝。没有固定测试文件或 selector 时，使用 API 响应和 DB 记录替代，不标“UI 自动化通过”。
- 旧 GET/health：浏览器网络面板或 API 客户端保存状态、响应头和 JSON。Web health 的 OSS 缺失检查只能在受控 aliyun-runtime 测试配置执行；预览环境的 `200 preview` 不构成该场景证据。

## 清理与回滚

1. 停止本次启动的 Web/API/Worker，保存最后 200 行日志及退出码。
2. 由环境管理员按 `RUN_ID` 精确筛选并删除测试库记录，或销毁专用临时测试库；禁止对共享库执行无条件删除、truncate 或回滚迁移。
3. 复核本次前缀的业务、audit、Outbox 记录已清零，或记录未清理原因和责任人。不得删除日志、截图或失败证据。
4. 本规程没有生产回滚步骤；任何需要部署回滚的情况超出本验收，立即升级给主任务。
