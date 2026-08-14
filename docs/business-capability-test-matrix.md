# 基础业务能力—测试覆盖矩阵

> 证据基线：accepted `main@aa327330b7ae0deb7b4a5ee3257b6a8221309903`（Stage 11 Scope A 受控本机技术验收 GO）。
>
> 取证范围：`packages/contracts/src/{commands,supply-writes,operations-writes}.ts`、`apps/api/src/composition/supply-writes-manifest.ts`、`apps/api/src/composition/operations-writes-manifest.ts`、相关 handlers，以及 `tests/`、`apps/api/test/`、`apps/worker/test/` 的已命名测试，并结合 [Stage 10 基础业务测试报告](./refactor/stage10-business-invariant-test-report.md) 与 [Stage 11 自动化 E2E 报告](./refactor/stage11-t2-scope-a-e2e-report.md)。这里的“已有证据”不等同于完整业务闭环、真实部署验证或覆盖率结论。

> 术语说明：本文沿用 R2/R3 作为 Scope A 写迁移两批命令的历史代号；代码已改用领域名 supply（供应侧）与 operations（履约财务侧），冻结的 `r2.*`/`r3.*` 命令名、writer resource 与 registration ID 不变。
## 读法与共同边界

- R2 是主数据/采购的 12 个命令；每个写命令要求 `idempotency-key`，进入相同来源、CSRF、会话和数据库可用性边界。
- R3 是履约/财务的 13 个命令；`OPERATIONS_COMMAND_RESOURCES` 将每个命令绑定 writer resource，统一命令执行器负责命令摘要、幂等、fence、审计和 Outbox 协作。
- `pnpm test:non-mysql` 选择 `tests/`、`apps/api/test/`、`apps/worker/test/` 中全部非 `.integration.test.mjs` 文件；`pnpm test:mysql` 选择普通数据库 integration（显式排除 `e2e-*`），且需要五个显式 MySQL URL，skip 视为失败。Scope A E2E 由 `test:e2e-foundation` / `test:e2e-scope-a` 独立运行。矩阵按测试层级建议，不把文件数或百分比当成目标。
- Stage 10 已补齐 12 条 R2 与 13 条 R3 route/identity/早拒绝的参数化合同证据；Stage 11 又对 purchase plan、SKU、supplier-SKU、purchase order、库存/调拨/盘点、生产/质检、物流/退货和财务负路径进行了真实 loopback E2E。它们仍不等于 25 个 handler 的逐字段 MySQL 全覆盖。

| 业务域 | 正常路径与合同入口 | 校验、权限/数据范围 | 状态不变量 | 重复/并发 | 审计/Outbox | 已有测试证据（路径与测试名） | 已知缺口与建议测试层级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IAM / 审批 | 登录、OTP、Step-up、角色授权；R3 `approvals.decide`。 | 命令 header 格式；同源/CSRF；会话、角色和组织范围；Step-up 绑定具体对象与版本。 | OTP/Step-up 的领取、过期、消费与审批 pending CAS 同一事务；旧写入口退役。 | 命令摘要重放一次、键复用拒绝；OTP 原子 claim/计数。 | 平台命令审计；审批 effect 与通知隔离。 | `tests/auth-otp-cas.test.mjs`：`login OTP uses atomic claim...`、`step-up OTP...`；`tests/step-up-security.test.mjs`：proof binding/审批 CAS；`apps/api/test/platform-write-foundation.test.mjs`：replay、CSRF、approval registrations；`apps/api/test/mysql-platform-routes.integration.test.mjs`：auth/OTP/CSRF/idempotency/scope。 | 未定位到“每种审批 effect × 批准/拒绝 × 重放”真实 MySQL 矩阵。**Critical，合同缺陷验证**：逐 effect 断言无越权副作用、只消费一次 proof（MySQL integration）。职责分离的最终角色组合需业务裁决后补 UAT 场景。 |
| 主数据 / 供应商 | R2 `master-data.write`、`suppliers.write`、supplier SKU/price/performance 和 import preview/stage/commit。 | R2 在 UnitOfWork 前拒绝 Origin、CSRF、仅角色和不匹配 factory binding；导入证据绑定上传者。供应商读按 factory/supplier 关系闭合。 | 供应商价格版本供 Step-up 使用；导入分 preview/stage/commit。 | R2 executor fence、commit-once、replay 和 digest-key 冲突拒绝。 | R2 命令的事件/真实审批通知分离；真实 MySQL R2 命令原子、审计、Outbox。 | `apps/api/test/supply-writes.test.mjs`：12 mappings、每条 R2 route 的 Origin/CSRF 早拒绝、replay、import owner；`apps/api/test/command-executor-parity.test.mjs`：每条 R2 command → writer resource 接线；`apps/api/test/mysql-supply-writes.integration.test.mjs`：`atomic, audited, outboxed, replayable, and fenced`。 | 单个 R2 MySQL 集成不能证明全部 12 个业务 handler 的字段/关系/状态效果。**Critical，合同缺陷验证**：按 12 个命令建立参数化 MySQL handler 合同；**Important，业务裁决**：供应商价格生效冲突、性能评分口径与审批链。 |
| 采购 | R2 `purchase-plans.create/update`、`purchase-orders.create/update`；读取合同返回计划版本、multi-factory item、订单、计划链接和提醒。 | factory scope 在 SQL/limit 前收敛；无有效 factory binding 或无关角色在数据库前拒绝。 | 计划版本、订单—计划链接和金额/数量应保持闭合；具体允许状态转移由 handler/业务规则定义。 | 使用 R2 command replay/fence；未定位到采购单并发编辑的专门 MySQL 用例。 | R2 通用审计/Outbox 覆盖；没有逐采购状态的命名 Outbox 断言。 | `apps/api/test/purchase-plans.test.mjs`：版本、factory scope、fail-closed；`apps/api/test/purchase-orders.test.mjs`：订单/链接/提醒/范围；R2 单元和 MySQL integration 如上。 | **Critical，合同缺陷验证**：计划/订单 update 的 stale-version、重复 key、失败后重试及 audit/outbox 原子性（MySQL integration）。采购收货、供应商价格服务端锁定与真实到货联动属于 [Scope B 记录](#scope-b-只记录不实现)，不进入本阶段实现。 |
| 库存 / 调拨 / 盘点 | R3 `inventory.reserve`、调拨 request/ship/receive、stocktake open/submit_count/finish_round。 | body 要求正整数、合法 warehouse/batch/scope；库存/盘点读按 warehouse/factory scope；盲盘不返回冻结数量。 | 调拨只能从各自前置状态迁移；批次余额条件扣减，库存不足不负；盘点动作由 discriminated schema 限定。 | R3 command 重放/fence；调拨 CAS 和条件扣库有专门 guard；全 R3 MySQL 测试含 inventory invariants。 | R3 执行器的审计/Outbox；真实 MySQL R3 测试覆盖通用原子性。 | `tests/inventory-transfer-guard.test.mjs`：前置状态、CAS、余额扣减；`tests/business-rules.test.mjs`：缺口/非负库存；`apps/api/test/inventory-read.test.mjs`、`stocktakes-read.test.mjs`：范围/脱敏；`apps/api/test/mysql-operations-writes.integration.test.mjs`：inventory/audit/outbox/replay。 | **Critical，合同缺陷验证**：两个并发 reserve/transfer/stocktake submit 针对同批次、相同及不同 idempotency key 的 MySQL 竞争测试，并断言库存流水、审计和 Outbox 一致。盘点差异入账与冻结策略的业务口径需裁决（Important）。 |
| 生产 / 质检（当前边界） | R3 production order create/start/materials/complete，quality inspection submit；读取生产单和质检记录。 | 合同限制数量、日期、stage、inspector type；质检读按 supplier/factory SQL scope。 | `complete` 可传 0 以到达 domain handler；质量结果允许 nullable；实际 BOM 预留/领料/消耗与质检放行/隔离并非当前闭环。 | 仅有 R3 通用 replay/fence 证据；未定位到 production/quality 的专门并发状态机 MySQL 用例。 | R3 通用审计/Outbox 证据；未找到按生产/质检动作逐项验证的命名断言。 | `apps/api/test/operations-writes.test.mjs`：13 routes、13 条 invalid-body schema 反例、Scope A 与 `production completion accepts zero...`；`apps/api/test/command-executor-parity.test.mjs`：每条 R3 command → writer resource 接线；R3 MySQL integration 如上。 | **Important，合同缺陷验证**：production/quality 各 action 的非法转移、重复请求、scope 和 audit/outbox MySQL 表驱动测试。真正 BOM 库存预留/领料/消耗、质检结果驱动库存放行/隔离是 [Scope B 记录](#scope-b-只记录不实现)，不补测试代码或业务实现。 |
| 发货 / 退货 | R3 shipment create/confirm/ship/receive/resolve_exception；return receive/inspect/propose/review；读取 shipment/return。 | 合同限制每个 action 的必填证据、数量、目的地；shipment/return 读取将 receiver/factory/supplier role scope 置于 LIMIT 前。 | 发货接收、异常与退货处置动作有离散 schema；具体跨单据数量守恒未在合同层穷尽。 | R3 通用 replay/fence；未定位到配送批次和退货并发争用的专门 MySQL 场景。 | R3 通用审计/Outbox；读取含证据、收货和异常关系闭合。 | `apps/api/test/shipments-read.test.mjs`：scope-before-LIMIT、evidence/receipt/exception closure；`returns.test.mjs`：角色绑定、子查询闭合、fail-closed；`apps/api/test/mysql-operations-writes.integration.test.mjs`：R3 通用不变量。 | **Important，合同缺陷验证**：每个 logistics/return action 的非法转移、收货/损坏数量边界、重复 command、文件 ACL 与 Outbox（MySQL integration）。退货财务结算规则需业务裁决后再写验收用例。 |
| 财务 | R3 finance create_invoice/verify_invoice/record_payment/invalidate/link replacement/refund/correction/release risk；finance read。 | 金额为整数且多数为正；高风险动作要求 server-consumed Step-up；读仅 internal roles。 | 可支付账本重算、退款/更正符号和受影响金额约束；payment 先锁定、校验 Step-up、写入并重算。 | 主键 `SELECT FOR UPDATE`、锁排序、第二笔超付拒绝；R3 replay/fence。 | 读审计敏感财务数据；R3 通用审计/Outbox 和 MySQL 事务证据。 | `tests/payment-concurrency-guard.test.mjs`：ledger/lock/overpayment；`tests/step-up-security.test.mjs`：finance 不信任客户端 `smsVerified`；`apps/api/test/finance.test.mjs`：范围/脱敏；`apps/api/test/mysql-operations-writes.integration.test.mjs`。 | **Critical，合同缺陷验证**：并发 payment/refund/correction × 相同/不同 idempotency key 的真实 MySQL 金额守恒、Step-up 消费、audit/outbox 断言。发票覆盖、税务和月结规则的最终业务口径需裁决（Important）。 |
| audit / outbox / 幂等 / 并发 | 平台命令及 R2/R3 command metadata 均返回 command、key、digest、replayed；writer resources 可独立 fence。 | command header 格式、同源/CSRF、session；unknown commit outcome fail-closed。 | 一次完成可重放，换 digest 复用键拒绝；fence/unknown outcome 不静默成功。 | R2/R3 使用共享 executor；支付锁、调拨 CAS、OTP CAS 有针对性测试。 | audit writer 参数化且五年保留；R2/R3 的真实 MySQL integration 明示 atomic/audited/outboxed。 | `apps/api/test/platform-write-foundation.test.mjs`：digest/replay/fence/unknown outcome；`apps/api/test/audit-writer.test.mjs`：retention/fail-closed；四个 `mysql-*.integration.test.mjs`：平台、R2、R3、write foundation。 | **Critical，合同缺陷验证**：生成“命令 × 幂等结果 × 审计行 × Outbox 事件 × fence”的可追溯参数矩阵，不能只依赖通用 integration 的一句断言。Worker 消费/投递至少需 Important 的失败重试、重复投递和 poison-event 合同测试；不触及真实 provider。 |

## Stage 11 后剩余测试与业务裁决清单

以下清单扣除了 Stage 10/11 已运行证据，仍是后续候选而非自动授权；优先级只表示进一步补强证据的风险顺序，不代表已确认生产缺陷，也不推翻 Stage 11 GO。是否继续投入应由业务风险和真实验收反馈驱动，不能为了穷尽矩阵而过度测试。

### Critical

1. **既有合同缺陷验证**：为 R2 的 12 个命令和 R3 的 13 个命令建立参数化真实 MySQL 合同套件。每行至少验证合法写入、非法 body/Origin/CSRF/role/scope 拒绝、相同 key replay、换 digest 拒绝、fence/unknown-outcome fail-closed，以及事务内 audit + Outbox。
2. **既有合同缺陷验证**：并发竞争套件覆盖 payment/refund/correction、inventory reserve/transfer 与 stocktake submit；以余额、状态、账本、审计和 Outbox 的最终一致性断言为准，不以请求返回数代替。
3. **既有合同缺陷验证**：审批 effect 的批准/拒绝、越权、Step-up 绑定与重复消费在真实 MySQL 中逐 effect 验证，确保不产生孤儿副作用或重复通知。

### Important

1. **既有合同缺陷验证**：production、quality、shipment、return、stocktake 的 action 状态机表驱动测试，覆盖非法转移、数量边界、重复 command、范围和审计/Outbox；生产和质检只验证现有 Scope A handler 边界。
2. **既有合同缺陷验证**：文件 quarantine/关系 ACL、导入 stage/commit 失败重试、Outbox consumer 的重复投递/失败重试/poison-event 合同测试；使用 stub，不使用真实 provider 或生产凭据。
3. **需要业务裁决**：审批职责分离角色矩阵、供应商价格生效冲突与绩效口径、采购计划/订单状态及盘点差异冻结策略。裁决写成可审计规则后，再形成 UAT/集成测试，不由测试自行假设。
4. **需要业务裁决**：发票覆盖/税务/月结、退货财务结算、发货损坏与异常关闭规则；先明确账务归属和数量守恒口径。

### Normal

1. **既有合同缺陷验证**：为现有各读模块补跨角色分页/排序/关联缺失的回归参数表，保持 scope-before-LIMIT、上限和脱敏；不把本地 preview 空 envelope 当生产可用证据。
2. **既有合同缺陷验证**：把 OpenAPI/Contract schema 与 manifest 的 route-method、成功码、错误 envelope 做快照或表驱动对比，包含 R2/R3 所有 command。
3. **需要业务裁决**：由业务 owner 确认各域的验收样本、保留期和 UAT 签字角色；这是一份测试数据与验收治理任务，不授权修改业务流程。

## Scope B：只记录，不实现

以下需求已在 README 和 Stage 材料中明确排除。它们不属于上述补充清单，不能借“补测试”进入实现、测试代码、真实部署或生产凭据范围：

- Purchase Receipt；
- BOM 实际库存预留、领料、消耗；
- 质检结果驱动的库存放行、隔离及批次闭环；
- 任何真实部署、真实 provider、生产数据或凭据验证。

当 Scope B 获得单独业务结果合同后，应另建能力/不变量/数据迁移/测试层级方案；本矩阵不预先定义其行为。
