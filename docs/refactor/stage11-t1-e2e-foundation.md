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

`status` 只有在以下全部通过时返回 ready：Docker label owner、fixture SHA、canonical migration 5/5、stub health、Worker ready、API ready、HTTPS、全量进程 PID。任意一项失败都会是 `blocked`，不可开始 T2 场景。

测试库只开启现有 `auth.commands`（验证 HTTPS Secure cookie/CSRF）和 `outbox.worker`（验证 stub-ready）。其他 writer fence 仍遵循既有受控 activation 合同；T2 在业务 owner 明确其 resource 集合与 activation evidence 前不得自行开启它们。

`cleanup` 只按 `RUN_ID` 状态文件和 `topology.e2e.run_id` label 删除资源；不会触碰未知容器、库、卷、进程或文件。它同时移除本运行的证书和日志。失败后的日志可先用于诊断，再运行同一精确 cleanup。

## T2 可用 fixture refs

每次 `prepare` 写入运行时 fixture manifest，其中有：`accounts.admin`、`supply_chain`、`factory`、`approver`、`finance`、`denied`，以及 `factoryId`、`supplierId`、`sku`、`bomId`、`warehouseId`、`batchId`、`supplierSkuId`、`approvalId`、`planId`、`planItemId`、`purchaseOrderId`、`orderItemId`、`executionOrderId`、`qualityInspectionId`、`stocktakeId`、`shipmentId`、`returnId`、`invoiceId`、`paymentRequestId`。T2 必须从该 manifest 读取，不得猜测 ID 或状态。

仍需业务裁决的项保持 blocked：审批职责分离、供应商价格/绩效、采购状态、盘点差异冻结、物流异常与退货财务、税务/月结。Scope B（采购收货、实际 BOM 消耗、质检驱动库存、真实 provider/payment）仍不在此底座范围。
