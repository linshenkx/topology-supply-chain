# Stage 11 T3 真人与 Agent 联合 E2E 最终验收报告

> **最终结论：GO（限当前冻结的 Scope A 技术验收）**
>
> 入口：`0d76ffc9f09734488d0836e70ba7b857b4d874ca`（父提交 `132af2585ed7a67ba1f8678be82036f0daac43e8`）。本报告只覆盖本机 loopback 的测试专用 MySQL、API、Worker、Web HTTPS 与 local stub；未连接真实 provider、生产凭据、生产环境或非 loopback 网络。本次未修改生产/测试/配置/schema/migration/identity/Docker/deploy，仓库唯一写入为本报告。

## 判定范围与身份冻结

- 生命周期在每个场景生成精确小写 `RUN_ID`、带 `topology.e2e.run_id` Docker label 的 MySQL 容器/临时库、随机 loopback 端口及 `E2E-<RUN_ID>-` fixture 前缀；`status` 实际核对 repository SHA、build/entry、fixture/seed SHA、canonical migration、HTTPS/API/Worker/stub ready 与已声明 fence profile。
- fixture/migration 合同为 `mysql.scope-a.0000-0004`；release manifest 的 schema、writer generation、command/resource identity 与 release compatibility 均由回归实际验证。`pnpm db:verify-generation` 复核 migration closure 仍为 22 文件且无 schema 生成差异。
- 物流写入已按冻结合同使用 `shipment_evidence.created_at`；退货检验使用 `product_return_inspections.inspected_at`。发货时间输入为 Web `datetime-local` 的 `YYYY-MM-DDTHH:mm`，没有将其升级或推断为 RFC3339/时区语义。

## 已执行的 Agent E2E 证据

可复现入口（均在仓库根目录执行）：

```powershell
pnpm test:e2e-foundation
pnpm test:e2e-scope-a
pnpm lint
pnpm typecheck
pnpm test:non-mysql
pnpm db:verify-generation
pnpm deploy:check-env-contract
```

| 范围 | Agent 实际证据 | 结果 |
| --- | --- | --- |
| Tier 1 foundation | 两个 RUN_ID 并行、hostile inherited env 隔离、HTTPS Secure cookie/CSRF、OTP/control/events 隔离、PID tamper fail-closed、部分启动恢复、精确清理 | **PASS**：1 pass / 0 fail / 0 skip |
| 身份、P1/P2、C1 | HTTPS 同源登录/OTP/local stub、缺 CSRF 拒绝、SMS `fail_once` 后 Worker retry、18/18 legacy GET 为 `410`/`WRITER_MOVED`/正确 successor Link | **PASS** |
| R2 | purchase plan、SKU、supplier-SKU、purchase order；首次写入、等同重放、同 key 改 payload `409 IDEMPOTENCY_KEY_REUSED`、跨 scope `403`；业务行/audit/outbox | **PASS** |
| R3 库存 | reservation/replay、同仓调拨 `400`、跨仓调拨和 stocktake；库存/audit/outbox | **PASS** |
| R3 生产/质检 | start → zero-complete（现有 handler 边界）、公司质检及不平衡数量 `400`；audit/outbox | **PASS** |
| R3 物流/退货 | `ship → receive → return receive → inspect → propose → review`；shipment `received`、evidence/receipt/inspection/approved disposition 各一条，shipping/returns audit 与 delivery-batch/product-return outbox 可关联 | **PASS** |
| R3 财务 | `invalidate_invoice`；无 server-consumed step-up 的 `record_payment` 为 `400 BAD_REQUEST`；audit/outbox | **PASS** |

所有上述证据均以 HTTPS API、MySQL 业务记录、`audit_logs`、`outbox_messages` 和 Worker/local stub 结果为事实来源；请求日志只保留路径、状态、错误码及 hash，不含密码、OTP、cookie、CSRF、token、DB URL 或 provider payload。

## 真人操作检查点（明确未自动宣称通过）

当前 Web 没有覆盖全场景的稳定 selector 与统一人工夹具，因此没有把 API 绿灯包装为“UI 自动化”或真人 UAT 签字。环境管理员/业务验收人应在同一 RUN_ID manifest 下，按 `docs/e2e/human-execution.md` 完成以下人工检查并保存脱敏截图：

- HTTPS 浏览器登录、OTP 与 Step-up：确认页面不显示 OTP/session 秘密，且 proof 不可跨对象、身份或过期复用。
- 各角色的组织/工厂可见性：管理员、供应链、工厂、审批、财务与无权角色，核对列表、详情和拒绝提示；API/DB 为最终事实。
- R2/R3 表单及通知：核对导入 preview/stage/commit 的三个操作、库存/物流/财务页面反馈；无 selector 时保留人工截图和 API/DB 关联，而非新增自动化断言。
- C2 Web `/api/health` 的 OSS 缺失 `503 degraded`：只可在受控 aliyun-runtime 本地配置执行；本次未构造该配置，故为 **NOT EXECUTED / HUMAN-CHECKPOINT**，不得以 preview `200` 替代。

这些项目不是本报告的伪造 PASS；它们是发布前真人观察与业务签字的交接项，不改变本次已运行 Scope A 技术门禁的 GO。

## 未执行、跳过和范围外

| 项目 | 状态 | 原因/边界 |
| --- | --- | --- |
| approval/step-up 逐 effect、职责分离矩阵 | NOT EXECUTED | 缺少已裁决的业务角色/effect 合同；不猜测。 |
| imports、supplier prices/performance、plan/order factory transition | NOT EXECUTED | 需要独立 fixture 或已裁决状态。 |
| Worker poison-event | NOT EXECUTED | 仅已验证 local SMS `fail_once` retry；不可外推所有 topic/provider。 |
| 物流数量守恒、损坏/异常关闭、退货结算 | NOT EXECUTED | 业务规则尚未裁决。 |
| Scope B | OUT OF SCOPE | purchase receipt、BOM 实物预留/领料/消耗、质检放行/隔离、真实支付/provider。 |
| 真实部署、真实 OSS/provider、生产数据/凭据、非 loopback 网络 | PROHIBITED / NOT EXECUTED | 本任务安全边界。 |

## 全量门禁结果

| 命令 | 实际结果 |
| --- | --- |
| `pnpm test:e2e-scope-a` | **8 pass / 0 fail / 0 skip** |
| `pnpm test:e2e-foundation` | **1 pass / 0 fail / 0 skip** |
| `pnpm lint` | **PASS** |
| `pnpm typecheck` | **PASS** |
| `pnpm test:non-mysql` | **387 pass / 0 fail / 0 skip**；Web system **4 pass / 0 fail / 0 skip** |
| `pnpm db:verify-generation` | **PASS**：无 schema 生成差异，migration closure 22 文件 |
| `pnpm deploy:check-env-contract` | **PASS**：46 个声明变量与 Web/API/Worker 注入合同 |
| `git diff --check`（写报告前） | **PASS** |

## 资源、清理与工作树

- Foundation 和 Scope A 每个 RUN_ID 都由 lifecycle 自行 stop/cleanup；最终复核为 **0** 个 `topology.e2e.run_id` Docker 容器、**0** 个该生命周期持有的 loopback 服务/PID/运行目录。`%TEMP%/topology-e2e-integrity` 为空的 integrity-root 目录可保留，但没有 RUN_ID key/state 或可运行资源。
- 初始工作树干净；写入本报告前 `git diff --check` 通过。完成后预期唯一变更是本文件；没有 secrets 落盘。

## GO/NO-GO

**GO**：在精确入口 SHA 上，Tier 1 测试底座与 Scope A 自动化共同证明了当前定义的身份、安全边界、writer fence、scope、幂等、审计、domain event、Outbox/retry、legacy retirement 及物流退货主链可在本机 loopback 环境中执行、取证和精确清理。

这不是 Scope B 完成、真实支付/provider/部署验收，也不是已经取得真人业务 UAT 签字的声明；上列 HUMAN-CHECKPOINT/NOT EXECUTED 项必须作为后续人工验收或独立业务裁决处理。
