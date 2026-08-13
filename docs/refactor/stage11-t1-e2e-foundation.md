# Stage 11 T1：测试专用 E2E 底座

本交付仅建立 Tier 1 本机测试底座，不包含任何 T2 自动化业务场景、生产部署、真实 provider、生产凭据、生产 schema/migration 或 Scope B。

## 入口

```powershell
$env:RUN_ID = 'e2e-20260813-ab12'
pnpm e2e:prepare
pnpm build:api
pnpm build:worker
pnpm build:web:preview
pnpm e2e:start
pnpm e2e:status
pnpm e2e:evidence -- --out <safe-evidence-json-path>
pnpm e2e:stop
pnpm e2e:cleanup
```

所有命令要求同一个小写 `RUN_ID`。`prepare` 会生成唯一的 loopback-only MySQL 8 容器与临时数据库，复核 frozen canonical migration 后 seed Scope A fixture；`start` 启动 loopback SMS/email/file-scan stub、Worker、API、Web 和 HTTPS same-origin proxy。证书、密钥、密码、cookie、OTP、CSRF、DB URL 与日志只留在操作系统临时运行目录，且不会出现在 Git/evidence。

## Fail-closed ready

`status` 只有在以下全部通过时返回 ready：当前 repository SHA、实际 build/entry identity、fixture JSON/seed module SHA、canonical migration 5/5、声明的冻结 fence profile 与数据库实际状态、Docker label owner、stub health、Worker ready、API ready、HTTPS、全量带 RUN_ID owner token 的进程 PID。任意一项失败都会是 `blocked`，不可开始 T2 场景。

默认 profile `foundation-auth-worker` 只开启现有 `auth.commands`（验证 HTTPS Secure cookie/CSRF）和 `outbox.worker`（验证 stub-ready）。测试专用的冻结 profile allowlist 还提供按 T2 场景精确选择的入口；不接受任意资源名或 blanket enable，`status` 会复核声明 profile 与数据库实际状态。它不替代业务 activation evidence。

`cleanup` 只按已完整性校验的 `RUN_ID` 状态文件和 `topology.e2e.run_id` label 删除资源；在 taskkill 前严格验证 PID wrapper 的 RUN_ID、随机 owner token 与 entry。不会触碰未知容器、库、卷、进程或文件。它同时移除本运行的证书和日志。失败后的日志可先用于诊断，再运行同一精确 cleanup。

## T2 可用 fixture refs

每次 `prepare` 写入运行时 fixture manifest，其中有：`accounts.admin`、`supply_chain`、`factory`、`approver`、`finance`、`denied`，以及 `factoryId`、`supplierId`、`pendingSupplierId`、已区分的 `sku`（finished）/`componentSku`、`bomId`、`warehouseId`、`batchId`、`supplierSkuId`、`approvalId`（`r2.supplier_onboarding`）、`planId`、`planItemId`、`purchaseOrderId`、`orderItemId`、`executionOrderId`、`qualityInspectionId`、`stocktakeId`、`shipmentId`、`returnId`、`invoiceId`、`paymentRequestId`。T2 必须从该 manifest 读取，不得猜测 ID 或状态。

已有 Scope A 自动化 E2E 的既有覆盖不因本底座而被全局标为业务 blocked。本底座只将尚未裁决的业务歧义（审批职责分离、供应商价格/绩效、采购状态、盘点差异冻结、物流异常与退货财务、税务/月结）和 Scope B（采购收货、实际 BOM 消耗、质检驱动库存、真实 provider/payment）列为后续场景阻塞项。
