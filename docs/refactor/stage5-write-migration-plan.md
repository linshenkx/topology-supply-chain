# Stage 5 写链路迁移与业务 UAT 计划

> 基线：`1d04a3e`。本文是可直接派发的实施计划，不是已完成声明。范围覆盖 Stage 5 采购切写，并把 Stage 6 实物闭环、Stage 7 物流/财务作为同一条受控写迁移列车排好依赖。任何生产 DDL、切流、部署、push 或业务代码实现均不在本文工作中发生。

## 1. 结论与执行边界

### 1.1 推荐结论

1. **先补写控制面，再迁任何业务 POST/PATCH/DELETE。** Fastify 当前数据库边界只有 `query/execute/close/ping`，没有事务 Unit of Work（`apps/api/src/infrastructure/database.ts:32-48`）；现有 MySQL migration/schema 中也没有 `writer_fence`、canonical 幂等记录、事务 Outbox。直接复制旧 Route 会保留当前非原子问题。
2. **开发准备可并行，业务切写必须串行。** 五个用户可见任务可以在共享控制面完成后并行开发各自契约、模块和 UAT fixture；真实 writer fence 只按 `采购 → Receipt/生产/质检/库存联合波次 → 发货/签收/退货 → 请款/发票/付款` 启用。
3. **生产、质检、库存是一个切写单元。** 旧完工会创建待检库存，但质检只写质检记录，未释放/隔离具体批次（`app/lib/production-finalization.ts:53-75`、`app/api/quality-inspections/route.ts:182-207`）；旧生产物料行只记字段，不创建/消费真实批次预留（`app/api/production-orders/route.ts:84-89`）。三者不得分别宣布完成或单独恢复 legacy writer。
4. **审批是编排入口，不是跨领域超级写者。** 每个 workflow 由所属领域的 `ApprovalEffectHandler` 在同一事务中完成审批 claim、领域副作用、审计与 Outbox；旧审批 Route 当前先 claim、再用独立写操作改多个领域表（`app/api/approvals/route.ts:68-89,143-276,278-390`），迁移后不得继续写已迁移领域表。
5. **财务系统先定位为“应付与已发生支付台账”，不发起银行支付。** 付款命令只登记外部已执行交易及凭证；未来真实银行支付必须另建 `PaymentInstruction`、银行适配器和回执状态机，不能把 `record_payment` 偷换成资金指令。

### 1.2 当前事实与缺口

| 事实 | 证据 | 对计划的约束 |
| --- | --- | --- |
| Stage 4 只切 GET，写仍在 `/api/*` | `docs/refactor/stage4-read-migration-implementation-notes.md:5-14` | 所有下表“当前写者”均为 legacy Next；v1 读接口不能被误判为已具备写能力。 |
| v1 contracts 目前是读响应 Schema | `packages/contracts/src/purchase-plans.ts:182`、`packages/contracts/src/finance.ts:126`；全仓无 write request schema | 每条新命令必须先落运行时 request/response/error contract，再写 handler。 |
| 旧事务适配在非阿里云环境直接执行 callback | `db/transaction.ts:7-20` | D1/preview 不能作为写原子性或并发证据；核心写必须在 MySQL 8 集成测试验证。 |
| 旧审计自行 `getDb()` 写入 | `app/lib/audit.ts:20-37` | 审计不与业务事务原子；v1 必须接收 transaction executor。 |
| 提醒/通知直接写表，邮件 Job 直接发外部请求 | `app/lib/reminders.ts:5-17,49-69`、`app/api/jobs/email/route.ts:15-29` | 业务命令只写 Outbox；Worker 负责通知、邮件、重试与死信。 |
| 现有 Step-up 只绑定文本 scope，消费时删除 challenge | `app/lib/step-up-policy.ts:5-12`、`app/lib/step-up.ts:43-58` | 写迁移前升级为绑定 session、对象版本和 canonical request hash 的 proof。 |
| 付款台账已有行锁和追加冲正雏形 | `db/row-lock.ts:47-78`、`app/api/finance/route.ts:561-609` | 保留“锁请款→重算 ledger→追加记录”的方向，但补业务唯一约束、法律主体和同事务审计/幂等。 |
| 当前 `payment_records.bank_reference` 无唯一约束 | `db/schema.ts:933-946` | 重复银行流水仍可能重复入账；必须用 DB unique 兜底。 |

## 2. 必须先落地的共享写协议

### 2.1 Expand-only 数据结构

共享基础任务是所有领域写迁移的硬依赖，且由**一个数据库迁移 owner** 串行维护 MySQL migration 与显式 MySQL schema。

| 结构 | 最小字段/约束 | 用途 |
| --- | --- | --- |
| `writer_fences` | `command_type PK`、`owner enum(legacy,v1,blocked)`、`epoch`、`activated_at`、`changed_by`、`reason` | 用例级唯一写者；不能只按整个 Route 粗切。 |
| `idempotency_records` | `actor_id`、`canonical_command_type`、`aggregate_key`、`idempotency_key`、`request_hash`、`status`、`response_json`、`resource_version`；unique `(actor_id, command_type, aggregate_key, key)` | v0/v1 共用幂等作用域；同 key 不同 hash 返回 409。 |
| `outbox_events` | `event_id`、`aggregate_type/id/version`、`event_type`、`payload_json`、`status`、`available_at`、`lease_owner/until`、`attempts`；unique `event_id` | 事务内记录待发送通知、邮件、文件扫描/关联、投影和对账事件。 |
| `outbox_deliveries` | `event_id`、`handler`、`status`、`attempts`；unique `(event_id, handler)` | 消费者去重、重试、死信和人工重放审计。 |
| `step_up_grants` | `grant_id`、`user_id`、`session_id`、`action`、`entity_id/version`、`request_hash`、`nonce`、`expires_at`、`consumed_at`；unique `nonce` | 在业务事务中 CAS 消费高风险证明。 |
| 领域聚合 `version` | 所有会被状态转换的 header/子聚合 | `If-Match`/expected version 防丢失更新。 |
| 业务唯一键 | 下文逐命令列出 | 幂等表不是业务唯一约束的替代品。 |

Schema 前置门禁：先只读对齐生产 schema、`__drizzle_migrations` 与 DMS 人工变更；空库和脱敏生产副本重复升级；旧应用读取 Expand 后 schema；此门禁沿用 `docs/refactor/04-production-gates.md:60-70`，未签字不得切真实写。

### 2.2 每个命令的标准事务模板

```text
authenticate + authorize(scope) + validate contract
  → begin MySQL transaction
  → SELECT writer_fence FOR UPDATE; verify owner/epoch
  → claim idempotency record (same key + different hash => 409)
  → lock aggregate/ledger rows or CAS expected status/version
  → validate state/invariants from locked facts
  → write aggregate + immutable ledger/movement/effect
  → write audit_logs + outbox_events in the same transaction
  → persist stable response in idempotency record
  → commit
  → return response; Worker handles external side effects
```

- `execute` 超时或连接中断发生在提交结果未知区间时，API 返回稳定的 `COMMAND_OUTCOME_UNKNOWN`，客户端只用同一 `Idempotency-Key` 查询/重试，服务端不得换 key 自动重放。
- 审计失败使业务事务失败；邮件、站内通知、搜索/绩效投影失败不回滚业务事实，由 Outbox 重试。
- OSS 与数据库无法做单事务：先上传到 quarantine object key，完成魔数/扫描后由业务事务引用 `ready` 文件元数据；未引用对象由有审计的清理 Job 回收。
- 首次 v1 写入前可执行 R0 回切；首次 v1 写入后默认 R2（冻结、向前修复），库存/财务事实只能以 R3 补偿命令纠正，遵循 `docs/refactor/02-target-architecture.md:356-364`。

### 2.3 命令契约统一规则

- 显式命令子资源，禁止继续扩展 `body.action`：例如 `POST /api/v1/purchase-orders/{id}/factory-responses`，符合 `docs/refactor/02-target-architecture.md:230-235`。
- 所有创建/状态转换要求 `Idempotency-Key`；更新既有聚合要求 `If-Match` 或 body `expectedVersion`。
- 对外 ID 为 opaque string；金额为币种 + 最小单位整数；数量包含 unit/precision；时间戳含时区，业务日为 `YYYY-MM-DD`。
- 错误至少稳定覆盖：`VALIDATION_FAILED`、`FORBIDDEN_SCOPE`、`WRITER_FENCED`、`IDEMPOTENCY_MISMATCH`、`VERSION_CONFLICT`、`INVALID_STATE`、`INVARIANT_VIOLATION`、`STEP_UP_REQUIRED`、`COMMAND_OUTCOME_UNKNOWN`。
- 新旧入口用同一 canonical command type；legacy adapter 在迁移窗也必须检查 fence、写幂等记录、调用同一 application service，不能保留两套业务实现。

## 3. 推荐业务裁决

### 3.1 多工厂计划与采购单状态

当前 `purchase_plans.status` 是整单字段，而 item 和 response 才带 `factoryId`（`db/schema.ts:283-349`）；旧逻辑任一工厂确认/异议就直接更新整单（`app/api/purchase-plans/route.ts:92-124`）。推荐裁决：

- `PurchasePlanVersion` 是不可变版本 header；新增唯一 `(purchase_plan_id, factory_id)` 的 `PurchasePlanFactoryScope` 作为工厂级聚合，拥有 `awaiting_response/accepted/disputed/resolved/ordering/complete` 与独立 version/due date。
- header 状态只由所有工厂子状态派生：`awaiting_factory`、`partially_confirmed`、`disputed`、`confirmed`、`ordering`、`ordered_complete`；客户端不得直接写 header 状态。
- 工厂响应 unique `(plan_version_id, factory_id, response_revision)`；每个 factory scope 只接受本工厂 actor。异议处理后重新聚合，不覆盖历史响应。
- 商业采购单按 `buyer_legal_entity + supplier + currency` 建单；同一商业单可引用多工厂 allocation，但工厂确认/交期承诺落在 `PurchaseOrderFactoryFulfillment`，header 仍为派生摘要。若现实供应商合同按工厂独立，应用层直接拆为多张商业 PO，不引入微服务。
- 计划分配数量按 plan item 锁定并累计；`allocated + cancelled + remaining = planned allowance`，超/欠容差审批不能靠客户端价格、供应商或数量决定。

### 3.2 Receipt → 生产 → 质检 → 库存闭环

- `PurchaseReceipt` 归 Procurement，引用 PO line、供应商、收货工厂/仓、来源凭证；接收事务同步调用 Quality/Inventory application port，创建**来源明确、初始仅 `pending_inspection`** 的 inventory lot 和来料检验任务。
- `InventoryLot` 是可处分资产；所有余额来自不可变 `inventory_movements`，缓存余额只作为带 version 的 projection。每条来源事件有 unique `(source_type, source_id, movement_type, line_no)`。
- 生产单固定 BOM snapshot，不再只引用可变 `bomId`。物料需求必须分配到具体 lot reservation；`领用 = 消耗 + 损耗 + 退料`，release/consume 使用锁或原子条件，余额不得为负。
- 完工按 production report 创建来源唯一的成品待检 lot；`QualityInspection` 必须引用 `inventoryLotId`，数量满足 `lot qty = released + quarantined/pending_disposition + disposed`。
- 推荐允许部分放行，但以 disposition allocation 守恒；仅当批次属性（有效期、ownership、质量结论）不同才拆 child lot，并保留 `parent_lot_id`。抽检失败进入全检或处置；让步接收为高风险审批。
- 调拨、盘点、退货、发货都只能调用 Inventory application service，不能直接更新 `inventory_batches`。盘点差异通过 adjustment movement，绝不覆盖历史流水。

### 3.3 财务台账与真实支付边界

- PO、Receipt/Shipment payable event、请款、发票、付款记录全部显式带 `legal_entity_id`、counterparty、currency；不得继续用 `(factory_id, planned_payment_date)` 作为请款唯一分组（当前约束见 `db/schema.ts:476-494`）。推荐分组键：`legal_entity + payee + currency + due_date + settlement_rule_version`。
- 发货/验收产生 `PayableAccrual` 与 payment schedule，是系统事实；请款聚合引用 accrual，不由物流 Route 直接拼财务表。
- 发票双岗核验保留职责分离；有效分配不得超过发票可用金额或请款未覆盖金额。红票/作废冻结 allocation，补票/退款只追加 remediation 事实。
- `record-payment` 只登记外部已完成付款，必须提交银行账户、流水号、发生时间、金额和凭证，并消费绑定完整 request hash 的 Step-up。DB unique 至少覆盖 `(legal_entity_id, bank_account_id, bank_reference, original_record_type)`；冲正 unique `reverses_payment_record_id`。
- 系统不生成银行指令、不保存网银密钥、不声称“付款成功”。未来银行直连新增 `PaymentInstruction: draft→approved→submitted→accepted/rejected/unknown→settled`，双人审批与回执对账独立于账本登记。

## 4. 旧 Next 写端点逐项迁移控制表

说明：当前写者均为 `legacy Next /api/*`。`Tx` 表示业务表、幂等、审计、Outbox 必须同一 MySQL 事务；`CAS` 表示 expected status/version；`Ledger` 表示行锁 + 追加流水；`Saga` 仅用于 OSS/外部消息。所有响应都必须写入 canonical 幂等记录。

### 4.1 采购、生产、质量与库存

| 当前端点 / canonical command | 当前表与副作用 | 角色/组织范围 | v1 事务、幂等与并发不变量 | Outbox、补偿、前端切换与 UAT |
| --- | --- | --- | --- | --- |
| `POST /api/purchase-plans` → `procurement.plan.create-version` | `purchase_plans/items`，可建 `approval_requests`、reminder、audit；当前写入未包成一个事务（`app/api/purchase-plans/route.ts:149-202`） | admin/supply_chain；只能选择获授权 legal entity、factory、warehouse | Tx；key=`planNo+version`；DB unique 已有 `(plan_no,version)`；锁 BOM/price/rule snapshot；禁止客户端注入未审批事实 | Outbox `ApprovalRequested/FactoryConfirmationDue`；补偿 `supersede/cancel draft`；`PurchaseWorkspace` 创建入口补 v1 client；UAT-PROC-01/02/03 |
| `PATCH /api/purchase-plans` 工厂响应 → `procurement.plan.factory-respond` | `factory_plan_responses`、plan header、approval、audit（`app/api/purchase-plans/route.ts:92-138`） | factory 且 actor.factoryId=scope.factoryId | Tx+CAS factory-scope version；key=`planVersion:factory:responseRevision`；单厂响应不改变其他厂事实，header 只派生 | 异议 Outbox；补偿为新 revision，不覆盖；切 `app/components/PurchaseWorkspace.tsx:98-101`；UAT-PROC-01/04 |
| `PATCH /api/purchase-plans` finalize → `procurement.plan.finalize-allocation` | plan items completion、approval、plan status、audit（`app/api/purchase-plans/route.ts:63-90`） | admin/supply_chain，legal entity scope | Tx；锁全 plan items；key=`planVersion:allocationRevision`；累计 allocation 守容差，不能重复结案 | `PlanDeviationRequested`；补偿 reopen 需审批；切 `app/components/PurchaseWorkspace.tsx:86`；UAT-PROC-05 |
| `POST /api/purchase-orders` → `procurement.order.create` | PO/items/plan links、累计 ordered qty、approval；事务后另写 reminder/audit（`app/api/purchase-orders/route.ts:56-110`） | admin/supply_chain；buyer entity + supplier + factory allocations scope | Tx；key=`buyerEntity:externalOrderNo`；锁 plan items，验证 supplier-SKU、approved price/BOM snapshot；allocation 总和不超容差 | Outbox factory confirmation/approval；取消 PO 释放 allocation，不删记录；当前 UI 似无创建调用，UAT 前补真实入口；UAT-PO-01..04 |
| `PATCH /api/purchase-orders` → `procurement.order.factory-respond` | PO header、approval、audit（`app/api/purchase-orders/route.ts:117-156`） | factory，仅本厂 fulfillment | Tx+CAS fulfillment version；key=`po:factory:revision`；header 派生部分确认/异议/全确认 | DueDateDisputed Outbox；新 revision 补偿；切 `app/components/PurchaseWorkspace.tsx:117-121`；UAT-PO-05/06 |
| `POST /api/imports/commit` 采购类型 → `procurement.import.commit` | 旧 commit 目前只真正写 supplier，其他类型可能标 committed（`app/api/imports/commit/route.ts:19-52`） | admin/supply_chain，按 import type + entity scope | Tx；key=`importBatchId+fingerprint`；逐行 domain command，同批全成或显式 resumable checkpoint；不得直接写采购表 | ImportCommitted/Rejected；失败保留 staging；导入弹窗切 v1 domain commit；UAT-IMP-01..05 |
| 新 `POST /api/v1/purchase-receipts` → `procurement.receipt.receive` | 当前**无端点/无聚合**，是 BIZ-003 | receiving/supply_chain，限定 PO legal entity、factory/warehouse | Tx+Ledger；key=`supplierDeliveryNo+PO line`；锁 PO line cumulative received；unique receipt source；同步创建待检 lot + inspection task | Outbox evidence/notice；反收货需审批并生成反向 movement；UAT-REC-01..06；Stage 5 只建 contract/fixture，随实物联合波次启 writer |
| `POST /api/production-orders` → `manufacturing.order.create` | execution order/material lines；当前材料 `reservedQuantity` 只是理论数（`app/api/production-orders/route.ts:55-90`） | admin/supply_chain 或本厂 factory；order allocation 必须属于本厂 | Tx；key=`orderAllocationId+productionSplitNo`；unique source；固定 BOM snapshot；创建真实 lot reservations，允许 shortage 状态 | MaterialShortage/OrderCreated；取消释放 reservation；切 `app/components/ProductionWorkspace.tsx:39-40`；UAT-MFG-01..04 |
| `PATCH ... action=start` → `manufacturing.order.start` | update execution status（`app/api/production-orders/route.ts:95-108`） | 本厂生产授权；内部跨厂须显式 permission | Tx+CAS planned→in_production；key=`executionId:start` | Started event；误启动只能经 cancel/stop command；同一前端切点；UAT-MFG-05 |
| `PATCH ... action=materials` → `manufacturing.material.issue-consume-return` | 旧代码直接覆盖 material line 数量，无 inventory movement（`app/api/production-orders/route.ts:109-123`） | 本厂 warehouse/material operator | Tx+Ledger；逐 lot 锁 reservation；命令拆 issue/consume/return/loss；数量守恒且不负数；source unique | MaterialIssued/Consumed/LossVariance；反向 movement 补偿；UAT-MFG-06..10 |
| `PATCH ... action=complete` → `manufacturing.order.complete` | report、approval、execution status、待检 batch；多次独立写（`app/api/production-orders/route.ts:124-162`） | 本厂生产发起；偏差由 supply_chain 审核 | Tx+CAS；key=`executionId:completionRevision`；unique report/source lot；材料账平才可完工 | QualityTaskCreated/VarianceRequested；错误完工用 reversal lot movement；UAT-MFG-11..15 |
| `POST /api/quality-inspections` → `quality.inspection.submit` | `quality_rules`（甚至按需创建默认）、`quality_inspections`、audit；未绑定 inventory batch（`app/api/quality-inspections/route.ts:128-215`） | company_qc 或被明确委派的 supplier_qc；supplier/factory/lot scope | Tx+Ledger+CAS inspection task；key=`taskId:revision`；规则必须预先版本化，提交时不得静默创建；released+quarantine 守恒且重复提交不重复释放 | InspectionCompleted/DispositionRequired；纠错新 revision + reversal movement；当前 `QualityPanel` 无真实 API 调用，先补 UI 再切；UAT-QA-01..09 |
| `POST /api/inventory` reserve → `inventory.reservation.create` | 条件扣 batch 后另插 reservation/audit（`app/api/inventory/route.ts:141-190`） | admin/supply_chain 或本厂 warehouse scope | Tx+Ledger；key=`entityType:entityId:line:revision`；锁/CAS lot；available→reserved，不允许半成功 | ShortageDetected；release/consume 为补偿；切 `app/components/InventoryWorkspace.tsx:43`；UAT-INV-01..05 |
| `POST /api/inventory/transfers` → `inventory.transfer.request` | transfer、approval、audit 分离（`app/api/inventory/transfers/route.ts:27-54`） | 有调出仓权限；目标仓必须 active | Tx；key=`clientTransferNo`；unique transfer_no；源/目标不可相同；冻结检查 | ApprovalRequested；pending 可 cancel；切 `app/components/InventoryWorkspace.tsx:56`；UAT-TRF-01/02 |
| `PATCH ... ship/receive` → `inventory.transfer.ship/receive` | CAS transfer，FEFO 扣源 batch或建目标 batch + movements（`app/api/inventory/transfers/route.ts:58-138`） | ship=源仓；receive=目标仓；supply_chain 审批职责分离 | Tx+Ledger+CAS；key=`transferId:action:version`；按稳定顺序锁 lot；out=in；重复 receive 不建第二批 | TransferShipped/Received；在途丢失/误收用 disposition/反向 movement；切 `app/components/InventoryWorkspace.tsx:67`；UAT-TRF-03..08 |
| `POST /api/stocktakes` → `inventory.stocktake.open` | stocktake、snapshot counts、reminder、audit 分离（`app/api/stocktakes/route.ts:37-60`） | supply_chain/admin 或授权仓库 owner；一仓一 active stocktake | Tx；key=`warehouse+scope+cycleNo`；unique active warehouse（DB 可执行约束/锁）；冻结 snapshot 与开单原子 | StocktakeOpened；取消解冻需审计；切 `app/components/StocktakeWorkspace.tsx:39`；UAT-STK-01/02 |
| `PATCH ... submit_count` → `inventory.stocktake.count` | upsert count（`app/api/stocktakes/route.ts:74-89`） | 指派工厂/仓库；recount 必须不同 actor | Tx+CAS round；key=`stocktake:round:lot`；不可覆盖已封存 round，重报需 revision | CountSubmitted；错误计数以新 revision；切 `app/components/StocktakeWorkspace.tsx:50`；UAT-STK-03/04 |
| `PATCH ... finish_round` → `inventory.stocktake.finish` | status/adjustments/approval/reminder/audit 多次写（`app/api/stocktakes/route.ts:91-112`） | supply_chain/admin；盘盈日期字段受权限控制 | Tx+Ledger+CAS；key=`stocktake:round:finish`；所有 snapshot 已计；调整审批 unique，应用时 source movement unique | VarianceApprovalRequested/Completed；批准后只能反向 adjustment；切 `app/components/StocktakeWorkspace.tsx:59`；UAT-STK-05..09 |

### 4.2 发货、签收、退货、请款、发票与付款

| 当前端点 / canonical command | 当前表与副作用 | 角色/组织范围 | v1 事务、幂等与并发不变量 | Outbox、补偿、前端切换与 UAT |
| --- | --- | --- | --- | --- |
| `POST /api/shipments action=create` → `logistics.shipment.plan` | `delivery_batches` + audit（`app/api/shipments/route.ts:130-176`） | supply_chain/admin；source execution/legal entity scope | Tx；key=`executionId+batchNo`；现有 unique `(execution,batchNo)`；可发数量不超 released lot | ConfirmationDue；cancel plan；切 `app/components/ShippingWorkspace.tsx:74`；UAT-SHP-01/02 |
| `action=confirm` → `logistics.shipment.factory-confirm` | header status + audit（`app/api/shipments/route.ts:179-200`） | 本厂 factory；内部须显式权限 | Tx+CAS；key=`shipment:confirm:version` | Confirmed；新 revision 纠错；切 `app/components/ShippingWorkspace.tsx:108`；UAT-SHP-03 |
| `action=ship` → `logistics.shipment.dispatch` | approval；FEFO batch 扣减、movement、evidence、shipment；事务内又直接生成 payment schedule/request（`app/api/shipments/route.ts:203-388,479-571`） | 本厂 shipping 或 supply_chain；仅 released company inventory | Tx+Ledger+CAS；key=`shipment:dispatch:version`；一次 dispatch=一次扣库；lot deductions=sum shipment qty；**只生成 PayableAccrual event，不直接拥有财务聚合** | ShipmentDispatched + PayableAccrued；误发用 shipment reversal + inventory reverse，经审批；切 `app/components/ShippingWorkspace.tsx:129`；UAT-SHP-04..10 |
| `action=receive` → `logistics.shipment.receive` | receipt、exception、shipment status、audit 分离（`app/api/shipments/route.ts:390-456`） | receiver，必须用 receiver_org_id scope，禁止 destination 名称匹配 | Tx+CAS；key=`shipment:receiver:receiptRevision`；累计签收≤发货；少货/破损分量守恒；receipt source unique | Received/LogisticsExceptionOpened；更正新 revision；切 `app/components/ShippingWorkspace.tsx:136`；UAT-RCV-01..06 |
| `action=resolve_exception` → `logistics.exception.resolve` | exception status + audit（`app/api/shipments/route.ts:459-476`） | supply_chain/admin 且 legal entity scope | Tx+CAS；key=`exception:resolutionRevision`；resolution 必须关联补发/索赔/退货等效果 | ExceptionResolved；reopen 为新命令；切 `app/components/ShippingWorkspace.tsx:106`；UAT-RCV-07 |
| `POST /api/returns action=receive` → `returns.receive` | 直接创建 quarantined batch + return + audit（`app/api/returns/route.ts:57-94`） | supply_chain/receiving；源 shipment 与退回仓 scope | Tx+Ledger；key=`returnNo`；累计退货≤已签收可退；source movement unique；初始 quarantine | ReturnReceived/InspectionRequested；拒收或反收货反向 movement；切 `app/components/ShippingWorkspace.tsx:141`；UAT-RET-01..03 |
| `action=inspect` → `returns.inspect` | inspection、return status、audit（`app/api/returns/route.ts:97-130`） | company_qc 或明确 supplier_qc delegation | Tx+CAS；key=`return:inspectionRevision`；passed+failed=return qty；绑定 quarantine lot | DispositionRequired；修订 + reverse；切 `app/components/ShippingWorkspace.tsx:147`；UAT-RET-04 |
| `action=propose` → `returns.disposition.propose` | disposition rows + audit（`app/api/returns/route.ts:133-156`） | 本厂 factory；不能越 source factory | Tx；key=`return:proposalRevision`；restock+rework+scrap=可处分量；unique type/revision | ApprovalRequested；supersede proposal；切 `app/components/ShippingWorkspace.tsx:151`；UAT-RET-05 |
| `action=review` → `returns.disposition.review` | disposition、batch quantities、movement、return status、audit；已有事务壳（`app/api/returns/route.ts:178-213`） | supply_chain/admin；禁止自审 | Tx+Ledger+CAS；key=`proposal:decision`；审批/库存效果原子；每个 disposition source movement unique | Restocked/Rework/Scrapped；仅补偿 movement；切 `app/components/ShippingWorkspace.tsx:143`；UAT-RET-06..09 |
| 发货派生 → `finance.payable.accrue` / `finance.payment-request.generate` | 当前 shipment helper 直接写 schedules/requests/items（`app/api/shipments/route.ts:479-571`） | 系统 service actor；财务按 legal entity 读取，供应链按业务范围 | Tx（与 dispatch 同事务可同步 application call）；key=`shipmentId:payableRuleVersion`；unique accrual source；request group 用 legal entity/payee/currency/due/rule | PayableReady/InvoiceRequired；取消 shipment 追加 reversal accrual；UAT-PAY-01..04 |
| `POST /api/finance create_invoice` → `finance.invoice.register` | invoice + audit；之后 allocation 在 verify 流程（`app/api/finance/route.ts:378-438`） | supply_chain/admin，限定 buyer legal entity；文件 ready | Tx；key=`legalEntity+invoiceNo`；invoiceNo legal scope unique；金额、税、PO/payee一致 | InvoiceRegistered；作废不能 delete；切 `app/components/FinanceWorkspace.tsx:48`；UAT-FIN-01..03 |
| `verify_invoice` → `finance.invoice.verify` | verification、invoice、allocations、payment request coverage；部分逻辑跨 helper（`app/api/finance/route.ts:441-540`） | supply_chain/finance 各自岗位；同人不得双岗核验 | Tx+CAS；key=`invoice:role`；DB unique 已有 `(invoice,role)`；allocation 两端均不超额，按稳定顺序锁 | InvoiceVerified/Rejected/PaymentRequestFundable；反向 release allocation；同一前端入口；UAT-FIN-04..08 |
| `invalidate_invoice` → `finance.invoice.invalidate` | freeze allocation/request、invalidate invoice、exception、reminder、audit 分离（`app/api/finance/route.ts:138-197`） | finance/admin；legal entity scope | Tx+Ledger+CAS；key=`invoice:invalidationRevision`；affected amount≤有效 allocation；一次 open exception | RemediationDue；不得恢复原票，补票/退款结案；UAT-FIN-09/10 |
| `link_replacement_invoice` → `finance.invoice-remediation.link` | link、replacement status、exception coverage，已有 exception row lock（`app/api/finance/route.ts:200-249`） | finance/supply_chain；同 legal entity/counterparty | Tx+CAS；key=`exception+replacementInvoice`；DB unique 已有；补票+退款≤affected | RemediationProgress；错链用 reversal link；UAT-FIN-11 |
| `record_refund` → `finance.refund.record` | payment record + exception amounts，已有财务锁（`app/api/finance/route.ts:252-317`） | finance/admin；Step-up 绑定完整退款意图 | Tx+Ledger+CAS；key=`bankAccount+bankRef+refund`；退款不超 exception remaining；银行流水 unique | RefundRecorded；冲正追加；UAT-FIN-12/13 |
| `request_record_correction` → `finance.ledger-correction.request` | approval request + audit，Step-up（`app/api/finance/route.ts:320-375`） | finance/admin，禁止后续自审 | Tx；key=`originalRecord+correctionRevision`；proof 绑定新金额/日期/流水/目标请款/version | ApprovalRequested；取消 pending；`app/components/FinanceExceptionWorkspace.tsx:35-45` 切 v1；UAT-FIN-14 |
| `release_invoice_risk` → `finance.invoice-risk.release` | exception + Step-up + audit（`app/api/finance/route.ts:90-133`） | supply_chain_lead/admin；必须确认该正式角色 | Tx+CAS；key=`exception:risk-release:version`；proof 绑定 reason/evidence/hash | RiskReleased；再冻结为新 command；UAT-FIN-15 |
| `record_payment` → `finance.payment.record-external` | locked request、payment record、request status、audit（`app/api/finance/route.ts:541-630`） | finance/admin；legal entity + bank account scope；Step-up | Tx+Ledger+CAS；key 可由银行流水 canonical 化；net paid≤payable、invoice fully valid；DB unique bank reference；proof 与事务原子消费 | PaymentRecorded；错误只追加 reversal/correction；切 `app/components/FinanceWorkspace.tsx:77-81` 的 proof 流和 POST；UAT-PMT-01..08 |
| `POST /api/approvals` 财务/物流 workflow → `approvals.decide` + owned effect handler | approval + correction/shipment/return等表 + audit；当前只有 financial correction 将 claim 放入同一财务锁事务（`app/api/approvals/route.ts:408-543`） | workflow policy；SoD；高风险 Step-up；legal/org scope | Tx+CAS approval pending；key=`approvalId:decision`；handler 与 approval claim 同事务；一次 decision/一次 effect | ApprovalDecided + domain events；错误 decision 不能覆盖，只新建纠正审批；切 `app/page.tsx:533-536`；UAT-APR-01..08 |

### 4.3 横切、主数据、账号与后台端点

这些端点不应阻塞“采购到付款”每个业务波次的开发，但对应依赖必须在首次使用前切换。主数据/账号不与业务领域合并为微服务；仍在同一模块化单体，以 application ownership 隔离写表。

| 当前端点 | 当前写入/副作用与范围 | 推荐迁移、原子性、补偿与 UAT |
| --- | --- | --- |
| `POST /api/approvals` 所有 workflow | 可写 suppliers、supplier SKU/price、SKU/BOM、采购、仓库、盘点、生产、用户与财务，workflow 列表见 `app/api/approvals/route.ts:89-408` | `POST /api/v1/approvals/{id}/decisions`；Approval 模块只 claim/policy，各领域 effect handler 写自己表；Tx+CAS+audit+outbox；SoD/并发 2/10/50 仅一次成功；被拒/批准不可覆写，错误需新纠正 workflow。 |
| `POST /api/auth/login`、`POST /api/auth/verify`、`POST /api/auth/logout` | credentials/challenges/users/trusted devices/session/cookie/SMS；旧登录已有部分 CAS transaction | IAM 独立迁移任务；login attempt/OTP consume/session create 原子；短信 Outbox/Saga；logout 幂等吊销；前端 `app/page.tsx:619,626`；UAT-IAM-01..08。 |
| `POST /api/auth/step-up/request\|verify` | auth challenge + SMS；proof 当前只绑定 scope | v1 建 grant，request hash 在请求 challenge 时确定、verify 只激活；业务事务 CAS consume；前端支付/审批/更正切换；UAT-STEP-01..08。 |
| `POST /api/files` | 先 OSS put，再 file_objects，再 audit（`app/api/files/route.ts:11-50`） | upload-session → quarantine → scan → ready；Saga + orphan cleanup；业务引用只接 ready object，文件 ACL 继承 entity scope；所有上传组件统一生成 client；UAT-FILE-01..07。 |
| `POST /api/imports/preview|stage|commit` | parser；import batch/staging/domain rows/approval/audit；stage/commit 多次独立写 | preview 无业务写；stage Tx；commit 调领域 port + fence + idem，不能直接写领域表；供应商/SKU/采购/期初库存分别由 owner；UAT-IMP-01..08。 |
| `POST /api/master-data` create_sku/create_bom | SKU/conversion 或 BOM/components + approval + audit，多次独立写（`app/api/master-data/route.ts:55-135`） | Master Data command 子资源；Tx；unique code/version；BOM snapshot 被交易引用后不可改；补偿 retire/supersede；前端 `app/components/MasterDataWorkspace.tsx:59`；UAT-MD-01..06。 |
| `POST /api/suppliers` | supplier + onboarding approval + audit | Supplier module Tx；legal/tax identity unique；factory tier scope；补偿 deactivate；`app/components/SupplierWorkspace.tsx:47`；UAT-SUP-01..04。 |
| `POST /api/supplier-skus` | upsert relation + approval + audit | 禁止覆盖 active history，改为 versioned relation；Tx；unique effective range；工厂只管本厂 tier-3；同上前端；UAT-SUP-05..08。 |
| `POST /api/supplier-prices` | agreement/change request/approval/audit；tier-3 可直接生效（`app/api/supplier-prices/route.ts:45-70`） | versioned price agreement；Tx；时间区间不得重叠；高风险 approval/SoD；交易快照；`app/components/SupplierPriceWorkspace.tsx:34,42`；UAT-PRICE-01..06。 |
| `POST /api/supplier-performance` review/weights | review 或 weight version + audit | 非主链；可在财务闭环后切。Tx；已有 review/weight unique；修订追加版本；`app/components/SupplierPerformanceWorkspace.tsx:42,51`；UAT-PERF-01..03。 |
| `POST /api/warehouses` create/request_merge/deactivate | warehouse/approval/status/audit；deactivate 查 blocker 后写（`app/api/warehouses/route.ts:46-83`） | Inventory master commands；merge/deactivate 锁仓与所有 blocker/active stocktake；不搬库存记录，只通过 transfer/adjustment；前端 `app/components/WarehouseWorkspace.tsx:30`；UAT-WH-01..06。 |
| `POST/PATCH/DELETE /api/users` | role request/approval；unlock credentials/sessions；audit（`app/api/users/route.ts:86-295`） | IAM commands；role assignment versioned、SoD + Step-up；unlock Tx 并 revoke sessions；front `app/page.tsx:419-445`；UAT-IAM-09..14。 |
| `POST /api/notifications` | mark message read | `POST /api/v1/notifications/{id}/read`; actor ownership CAS；天然幂等；无需业务 Outbox；UAT-NOT-01。 |
| `POST /api/jobs/reminders` | 扫 due reminders、改 invoice risk、建 notification | Worker lease claim；reminder→outbox/notification delivery 去重；不能由公开业务 API 调；UAT-JOB-01..04。 |
| `POST /api/jobs/email` | 调 webhook 后更新 sent/failed | Worker Outbox consumer；claim/lease、provider idempotency key、retry/dead-letter；外部成功但 DB 超时通过 provider key 查询；UAT-JOB-05..09。 |

## 5. 五个可独立派发的用户可见任务

开发分支可以并行，但共享文件和业务命令必须遵守下表的单一写入者。各任务都需独立 PR/commit、契约、MySQL 集成测试、UAT 报告；集成 owner 只处理共享注册文件，不重写领域逻辑。

| 任务 | 可见结果 | 唯一写入范围/单一写者 | 依赖与并行关系 | 完成门禁 |
| --- | --- | --- | --- | --- |
| **T1 写控制面与横切闭环** | Fastify transaction UoW、writer fence、canonical idem、Outbox Worker、事务审计、Step-up grant、文件状态机、approval policy/effect port | 单一 database/control-plane owner 写 MySQL migrations、shared DB infra、Outbox/worker、approval kernel、shared error/idempotency contract；其他任务只提交 schema requirement manifest | 首先开始；其 contract 冻结后 T2–T5 可并行开发；T1 未通过前任何业务 writer 保持 legacy/blocked | MySQL failure injection、unknown outcome、2/10/50 并发、old/new fence probe、Outbox retry/dead letter、audit atomicity、Step-up replay 全通过 |
| **T2 采购与多工厂分配** | 计划版本→工厂确认/异议→PO/分配→采购 import commit；Receipt contract/fixture ready | Procurement owner 独占 purchase plan/order/receipt application、contracts、tests、`PurchaseWorkspace` 写切换；只通过 Approval port；共享 registry 由 integration owner 一次写 | 依赖 T1；可与 T3/T4/T5 的 contract/内部实现并行；生产 cutover 最先 | UAT-PROC/PO/IMP；新旧读对账；legacy 采购入口 fence 拒写；多工厂 header 聚合正确 |
| **T3 Receipt、生产、质检、库存联合闭环** | 到货待检→放行/隔离；BOM lot reservation→领料/消耗/退料→完工待检→处置；调拨/盘点守恒 | Physical-flow owner 统筹 Procurement receipt port、Manufacturing、Quality、Inventory；每个表只有所属 module repository 可写；前端四个 Workspace 由本任务 owner 切 | 依赖 T1 与 T2 frozen receipt/BOM snapshot contract；可提前实现 ledger 和 fixtures；真实切写必须在 T2 后一次联合切 | UAT-REC/MFG/QA/INV/TRF/STK；逐 lot 对账；重复完工/质检/调拨无重复效果；首次实物写后 legacy 三领域均不可恢复 writer |
| **T4 发货、签收、退货与应付事件** | released inventory→dispatch→receiver receipt/exception→return quarantine/disposition；生成 PayableAccrual | Logistics/Returns owner 独占 shipment/receipt/return commands 与 `ShippingWorkspace`；Finance 只消费 typed payable port，不允许物流写财务表 | 依赖 T1 与 T3 inventory ports；可与 T5 内部 ledger 实现并行；真实切写在 T3 后 | UAT-SHP/RCV/RET/PAY；一次发货对应一次扣库/应付；receiver scope 不再用名称；文件失败关闭 |
| **T5 发票、付款台账与端到端 UAT** | accrual→请款→发票双核/占用→外部付款登记→红票/补票/退款/冲正；整链审计/对账报告 | Finance owner 独占 payable/invoice/payment repositories、finance effect handler、Finance workspaces；不拥有银行支付指令；最终 UAT owner 只读汇总证据 | 依赖 T1 contract；可并行开发；真实切写依赖 T4 accrual；最后执行整链 UAT | UAT-FIN/PMT/APR + 全链；duplicate bank ref/并发超付失败；ledger 可重建；明确显示“登记已支付”，不显示“发起/完成银行支付” |

共享文件冲突规则：`apps/api/src/runtime.ts`、contracts barrel、全局 OpenAPI、migration journal、根 package/lock 只由 T1/integration owner 写；领域任务不得各自修改这些共享文件。数据库表 ownership 见 `docs/refactor/02-target-architecture.md:139-145`，审批和 Worker 只能调用公开 application port。

## 6. 切写 runbook（每个 canonical command 重复执行）

1. **Ready**：contract、MySQL migration、副本升级、权限矩阵、并发/幂等、failure injection、UAT fixture、对账 SQL、补偿 command、dashboard/runbook 已签字。
2. **Record**：在离线只读副本重放脱敏 legacy 样本；禁止把会更新 session/audit 的 GET 当在线 shadow（Stage 4 已记录该限制）。
3. **Block**：事务内把目标 `command_type` fence 置 `blocked` 并递增 epoch；legacy/v1 都返回 `WRITER_FENCED`；等待旧实例在途排空。
4. **Reconcile**：按 canonical identity 对齐业务表、ledger、幂等、audit、outbox；差异非零则恢复到 R0 legacy（仅首次 v1 写入前）。
5. **Activate**：事务内 owner→`v1` + epoch++；先开启合成探针，再切前端 generated client/Nginx。旧直连入口必须稳定 409/410 且不写表。
6. **Observe**：至少监测 error/latency、version conflict、idem hit/mismatch、Outbox lag/dead letter、scope denial、业务对账差异；禁止未知结果命令换 key 重放。
7. **Rollback/forward-fix**：首次 v1 写入后，若 legacy 未证明 schema/语义兼容，保持 blocked，部署 last-known-good v1 或向前修复；库存/财务走版本化 R3 补偿。

推荐 fence 粒度示例：`procurement.plan.create-version`、`procurement.plan.factory-respond`、`inventory.reservation.create`、`inventory.transfer.ship`、`logistics.shipment.dispatch`、`finance.payment.record-external`；不能只用 `purchase-plans` 或 `finance` 一个粗开关。

## 7. 业务 UAT 数据、场景与 oracle

### 7.1 固定 fixture

- 2 个 legal entity（至少一个可作为 pilot）、2 个 factory、2 个 supplier、2 个 warehouse、1 个 receiver organization。
- 成品 A + 两种组件，两个 approved BOM version，跨生效日；approved/expired supplier-price；正常与越容差规则。
- 同一计划含 factory A/B；A 确认、B 异议；PO 有分批 allocation、部分 Receipt。
- 组件库存跨 3 个 lot（不同 expiry），含 pending inspection、released、quarantine；并发 reservation 和 FEFO 场景。
- production order 有部分预留、loss variance、partial finish；quality 支持 pass/fail/partial release/full inspection。
- shipment 有按期/偏差、partial receipt、damage、return；invoice 有 full/partial、red/void/replacement；payment 有 partial、duplicate bank ref、refund/correction。
- 角色：admin、supply_chain、supply_chain_lead（待裁决）、finance 两人、factory A/B、company_qc、supplier_qc、receiver；每个外部角色有越权 ID 对照组。

### 7.2 必须自动判定的 oracle

| Oracle | 公式/判定 |
| --- | --- |
| 计划 | 每工厂响应独立；header=子状态纯函数；allocated/cancelled/remaining 守容差。 |
| 收货 | PO line `accepted receipt + reversed receipt ≤ allowed order qty`；一个来源只建一个 receipt/lot。 |
| 生产物料 | `reserved → issued = consumed + loss + returned`；每个 lot position 均 ≥0。 |
| 质检/批次 | `lot total = pending + released + quarantine + disposed`；inspection/disposition revision 不重复释放。 |
| 库存 | `opening + inbound - outbound ± adjustments = closing`，按 warehouse+SKU+lot 重算与 projection 一致。 |
| 发货 | `shipment qty = Σ lot deductions`；同 shipment 仅一个 effective dispatch 和一个 payable accrual。 |
| 签收/退货 | `received + shortage + damage = shipped`（按批准规则）；`return dispositions = accepted return qty`。 |
| 发票 | active allocation 不超 invoice effective amount，也不超 payment request uncovered amount。 |
| 付款 | `net payable ledger = payment + correction + reversal`（排除退款分类规则）且 `0≤net≤request total`；bank reference unique。 |
| 控制面 | 每 command 一个 idem 结果；业务事实、audit、outbox 全有或全无；旧 writer 在 v1 owner 时零写入。 |

### 7.3 UAT 执行矩阵

每组至少包含 happy path、权限越界、旧状态、重复同 key、同 key 不同 payload、2/10/50 并发、事务中断点、Outbox/OSS/短信不可用、补偿与重算 oracle。结果保存：Git SHA、DB schema/migration 摘要、fixture 版本、命令、requestId、SQL oracle、截图/附件摘要、业务签字人。

- **采购**：UAT-PROC-01..05、PO-01..06、IMP-01..08、REC-01..06。
- **实物**：UAT-MFG-01..15、QA-01..09、INV-01..05、TRF-01..08、STK-01..09。
- **物流/退货**：UAT-SHP-01..10、RCV-01..07、RET-01..09。
- **财务/审批**：UAT-PAY-01..04、FIN-01..15、PMT-01..08、APR-01..08、STEP-01..08。
- **横切**：UAT-IAM-01..14、FILE-01..07、JOB-01..09、旧入口拒写/unknown outcome/Outbox replay。

可直接交给测试 owner 的场景包如下；每个场景包都要套用上一段的重复、并发、断点和越权变体：

| UAT 场景包 | 操作与验收结果 |
| --- | --- |
| PROC-01..05 / PO-01..06 | 建同号新版本；A 厂确认、B 厂未响应/异议/获批新日期；分批 PO allocation、超量/欠量审批、并发 finalize。验收 header 始终等于 factory scope 聚合，未审批 supplier/price/BOM 被拒，同 key 重试只返回原结果。 |
| IMP-01..08 / REC-01..06 | 同 fingerprint 重复导入、坏行/缺 mapping、中断后同 key 续提；分批 Receipt、超收、反收货、无 PO 例外。验收 staging 可解释，committed 与领域事实全有或全无，receipt/lot/inspection task 来源唯一。 |
| MFG-01..15 | BOM 跨生效日、部分/全部 shortage、跨 lot 预留、领料/消耗/损耗/退料、偏差审批、并发完工。验收 snapshot 不漂移，材料式守恒，一份 report 只建一份来源 lot，错误完工只可补偿。 |
| QA-01..09 / INV-01..05 | 来料与成品抽检通过/失败、触发全检、部分放行、让步接收、重复 inspection；并发 reservation/release/consume。验收 pending/released/quarantine/disposed 守恒、零负数、越权 supplier_qc 看不到也写不到其他 scope。 |
| TRF-01..08 / STK-01..09 | 调拨请求/审批/发出/收货重放、源/目标盘点冻结；一盘/复盘不同人、零差异、盘盈新 lot、差异审批并发。验收 transfer out=in，重复 receive 无第二批，adjustment movement 可重建余额。 |
| SHP-01..10 / RCV-01..07 | 按期/偏差发货、2/10/50 并发 dispatch、OSS 凭证失败、部分签收、少货/破损、receiver 越权、异常关闭。验收一次扣库/一次 accrual，receiver 用 ID scope，异常 resolution 有实际业务引用。 |
| RET-01..09 | 重复 returnNo、超可退量、退货隔离、质检、工厂 proposal、发起人自审、restock/rework/scrap。验收退货来源和 movement 唯一，三种处置之和等于接受退货量，拒绝不释放 quarantine。 |
| PAY-01..04 / FIN-01..15 | 同 shipment accrual 重放；整单/批次发票、双岗核验、跨岗同人拒绝、allocation 竞争、红票/作废、补票/退款/risk release。验收 legal entity/payee/currency 一致，票额与请款覆盖均不超限。 |
| PMT-01..08 | 部分/尾款、同银行流水同 key/不同 key、并发超付、请求 hash 改金额/日期/账户、提交结果未知、退款、冲正/更正。验收仅一笔有效原始流水，净付款在 `[0,total]`，proof 仅消费一次，页面文案为“登记外部已支付”。 |
| APR-01..08 / STEP-01..08 | 每类 workflow 的角色、scope、自审、双并发 decision；过期/换 session/换 entity version/换 payload/重放 Step-up。验收 approval claim、effect、audit、outbox 同生共死，proof 任一绑定项变化即 428。 |
| IAM-01..14 / FILE-01..07 | 登录失败锁定并发、OTP 重放、logout/session revoke、角色授予/撤销 SoD；伪扩展名/魔数、超限、扫描失败、跨组织附件、孤儿回收。验收安全状态原子，业务只能引用 ready file。 |
| JOB-01..09 / CONTROL | 两 Worker 抢同 event、租约过期、provider 成功而 DB 超时、重试耗尽/人工重放；fence block/activate、legacy 直调、同 key 跨 v0/v1。验收一次 consumer effect、死信告警、完整重放审计、旧 writer 零写入。 |

业务签字：采购 owner 签 T2；工厂运营 + QC + 库存 owner 联签 T3；物流 + receiver owner 签 T4；财务 owner + 安全 owner 签 T5；release owner 只在全部 oracle 为零差异且作用域 P0 关闭时批准切写。

## 8. 最少用户裁决问题

其余项可先按本文推荐默认实现，真正影响 schema/状态机且必须在相应任务开始前确认的只保留四项：

1. **商业/法律主体**：factory 与 buyer legal entity、supplier/payee 的映射是什么；一张 PO 是否允许跨工厂，以及跨工厂时是否仍为同一 buyer entity/supplier/currency？（T2 入口）
2. **Receipt 与质量处置**：是否接受本文默认——无 PO 收货只走高风险例外；先入待检；允许数量级部分放行；让步接收需审批；不合格去向含退供应商/返工/报废？（T3 入口）
3. **外部组织范围**：receiver 的稳定组织 ID、supplier_qc 的委派关系、`supply_chain_lead` 是否为正式角色，分别由谁维护和签 UAT？（T3/T4/T5 入口）
4. **支付边界**：确认首期只登记外部已支付事实，不发银行指令；是否允许 UAT/试点用一笔真实已支付交易做台账核对，以及 bank account/reference 的唯一性范围？（T5 入口）

若第 1 或第 2 项否定推荐默认，需要先更新领域模型和 UAT oracle；不能在实现中临时猜测。D-11 历史迁移范围、D-16 通知时效、D-17 保留期可在不改变首个 command contract 的前提下并行决策，但生产前仍需签字。

## 9. 本计划的完成定义

本文可派发的判定标准：旧写端点全部有归属、目标 command、表/副作用、权限范围、事务/幂等/并发策略、审计/Outbox、补偿、前端切点和 UAT；五个任务有依赖和单一 owner；多工厂、实物闭环、财务/真实支付边界给出推荐裁决；没有把 Fastify 模块化单体过拆成微服务。

实施期间任何“暂时直接写另一模块表”“先不做 writer fence”“先发通知再补 Outbox”“用 D1/preview 代替 MySQL 并发证据”“首次 v1 写入后直接回切 legacy”均视为阻断偏差，必须回到评审而不是静默接受。
