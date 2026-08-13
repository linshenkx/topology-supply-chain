# Scope A 场景清单

所有路径以 API `http://127.0.0.1:3001` 为例；Web 只作为同域入口/人工观察。请求体须使用 Contracts/OpenAPI 当前 schema 的最小合法测试夹具，本文不伪造未固化的业务字段或状态迁移。共同 header 是有效测试会话、Origin、CSRF，以及每个写操作的唯一 `idempotency-key`；R2 还使用 `x-request-digest`。记录实际 HTTP 状态和错误 code。

| ID | 操作入口与步骤 | 预期和取证 | 失败/人工检查点 |
| --- | --- | --- | --- |
| A1 | 登录后请求 OTP、核验 OTP，再为一项审批或财务对象请求/核验 Step-up；分别以有权、无权、跨组织/工厂身份读取或提交。 | 有权身份取得受限范围；OTP/Step-up 对身份、目标和版本绑定，已消费/过期/换对象不可用。保存 HTTP、会话脱敏摘要、对象 ID、`audit_logs`。 | 职责分离的最终角色组合未裁决；记录实际角色矩阵并交业务 owner，不把 UI 文案当授权证据。 |
| A2 | `POST /api/v1/approvals` 以 `approved` 和 `rejected` 决策同一类 pending 测试项；再重放、改身份和改决策。 | 仅 pending 项能被正确权限决策；重复、越权或过期 Step-up fail-closed；保存 approval/version、审计和 effect/Outbox 关联。 | 每种 approval effect 的真实 MySQL 矩阵尚未全覆盖；无明确 effect 业务期望时停在人工裁决。 |
| R2-1 | `POST /api/v1/master-data`、`/suppliers`、`/supplier-skus`、`/supplier-prices`、`/supplier-performance`；`POST/PATCH /api/v1/purchase-plans`、`/purchase-orders`。所有名称带 `RUN_ID`。 | 记录 `command.command/key/digest/replayed`、范围内读取、业务 ID、`audit_logs` 与 `outbox_messages`。同 key 同 body 重放，换 digest 拒绝。 | 12 个 handler 的字段关系和采购状态效果未获得逐项 MySQL 验证；不由本手册定义价格冲突、绩效或状态口径。 |
| R2-2 | 依次 `POST /api/v1/imports/preview`、`/stage`、`/commit`，使用同一测试上传归属；分别尝试非上传者或改写导入身份。 | 三个命令有各自 metadata；stage/commit 仅接受可关联的测试导入，归属不符被拒绝。保存上传/导入关联、审计、Outbox。 | 没有稳定上传 UI selector/文件夹具时，以 API/DB 证据和人工页面检查替代；stage/commit 失败重试具体口径未全覆盖。 |
| R3-1 | `POST /api/v1/inventory` 创建 reserve；`POST/PATCH /api/v1/inventory/transfers` 申请、ship、receive；`POST/PATCH /api/v1/stocktakes` open、submit_count、finish_round。 | 正整数、范围、前置状态和批次余额边界生效；同请求可重放，非法转换/超量不静默成功；保存库存/调拨/盘点、审计、Outbox。 | 并发 reserve/transfer/stocktake 的真实 MySQL 竞争矩阵未完成；盘点差异和冻结口径待业务裁决。 |
| R3-2 | `POST/PATCH /api/v1/production-orders`（create/start/materials/complete）和 `POST /api/v1/quality-inspections`。 | 只验证当前 schema 和 handler 边界（例如 complete 可接受 0）；保存命令、审计、Outbox 和范围读取。 | 不验证 BOM 实际预留/领料/消耗，亦不验证质检驱动放行/隔离；两者为 Scope B。非法状态机细则仍需裁决/补测。 |
| R3-3 | `POST /api/v1/shipments`（create/confirm/ship/receive/resolve_exception）和 `POST /api/v1/returns`（receive/inspect/propose/review）。 | 离散 action 和必填证据字段受 schema 约束；记录业务/关联读取、审计、Outbox 与范围。 | 数量守恒、损坏/异常关闭、退货结算规则未裁决；文件 ACL/真实对象存储不可用时停止为人工检查点。 |
| R3-4 | `POST /api/v1/finance`：只以安全的现有测试夹具检查 create/verify/invalidate/link 等当前合同；需 Step-up 的动作分别检查有/无/错误 challenge。 | 高风险动作需要 server-consumed Step-up；记录账本/审计/Outbox 关联和 fail-closed 响应。 | 禁止真实支付；发票覆盖、税务、月结、退款/更正规则以及并发金额守恒仍待业务裁决和 MySQL 参数化验证。 |
| P1 | 对任一已完成 R2/R3 命令发送完全相同请求两次；随后以相同 key 改 body/digest；在受控测试夹具触发 fence 和 unknown outcome。 | 首次 `replayed:false`，等同重放 `replayed:true` 且不增加业务副作用；key/digest 冲突拒绝；fence/unknown 返回稳定 fail-closed code（如 `WRITER_FENCE_REJECTED`、`COMMAND_OUTCOME_UNKNOWN`）。 | 不可通过拔网络或修改生产配置伪造 unknown outcome；没有受控夹具时只复核已有自动化证据，标为未现场执行。 |
| P2 | 用 stub/测试消息观察 Worker 对 Outbox 的 lease、完成、失败重试或重复投递边界；关联同一 `RUN_ID` 的 audit/Outbox。 | 记录消息 ID、状态变化、attempt/可用时间（若存在）和 Worker 日志；重复消息不能被当作新业务写入。 | poison-event/真实 provider 的业务语义未形成完整合同；禁止真实通知、支付、OSS 调用，也不可手工更新 outbox 状态。 |
| C1 | 对 18 个旧业务 GET 发 GET 请求，逐一保存响应和 `Link`。 | 全部精确为 `410`，body code `WRITER_MOVED`，`Link: <successor>; rel="successor-version"`；successor 必须是对应 `/api/v1/*`。 | `/api/health`、`/api/session`、开发 bridge 不在这 18 个之内；不要以 404 或任一单一示例替代全数核对。 |
| C2 | 仅在受控 aliyun-runtime 本地测试配置中故意不提供可用 OSS，访问 Web `GET /api/health`。 | `503`，body 为受控 `status: degraded`，`checks.objectStorage: failed`，不含密钥、endpoint 细节或堆栈。保存脱敏响应和 Web 日志。 | 不访问真实 OSS；普通 preview runtime 的健康 `200` 不验证此项。若无法构造受控环境，标为未执行，不影响已记录的基础自动化门禁。 |

### C1 的完整 18 条路径

逐一访问以下 Web 同域旧入口（例如 `GET http://127.0.0.1:3000/api/approvals`），并将每条 successor 对照保存；不可只检查 API 内部路由或任意一个样例：

| 旧 GET | successor |
| --- | --- |
| `/api/approvals` | `/api/v1/approvals` |
| `/api/audit-logs` | `/api/v1/audit-logs` |
| `/api/finance` | `/api/v1/finance` |
| `/api/imports/diff` | `/api/v1/imports/diff` |
| `/api/inventory` | `/api/v1/inventory` |
| `/api/master-data` | `/api/v1/master-data` |
| `/api/production-orders` | `/api/v1/production-orders` |
| `/api/purchase-orders` | `/api/v1/purchase-orders` |
| `/api/purchase-plans` | `/api/v1/purchase-plans` |
| `/api/quality-inspections` | `/api/v1/quality-inspections` |
| `/api/returns` | `/api/v1/returns` |
| `/api/shipments` | `/api/v1/shipments` |
| `/api/stocktakes` | `/api/v1/stocktakes` |
| `/api/supplier-performance` | `/api/v1/supplier-performance` |
| `/api/supplier-prices` | `/api/v1/supplier-prices` |
| `/api/supplier-skus` | `/api/v1/supplier-skus` |
| `/api/suppliers` | `/api/v1/suppliers` |
| `/api/warehouses` | `/api/v1/warehouses` |

## 不能宣称完成的事项

- 测试矩阵列出的 Critical/Important 参数化 MySQL 合同、并发竞争、每个审批 effect 和 Worker poison-event 覆盖仍是后续工作，不因本手册存在而完成。
- 供应商价格/绩效、采购状态、职责分离、盘点冻结/差异、物流异常/损坏、退货财务、税务/月结需业务 owner 先给可审计结果合同。
- 所有 Scope B 与真实部署、真实 provider、生产数据/凭据均在本阶段之外。
