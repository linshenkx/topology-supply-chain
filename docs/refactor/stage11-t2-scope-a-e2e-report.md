# Stage 11 T2 Scope A 自动化 E2E 报告

> Accepted baseline: `9eab1d5b4c62f96d8b0863aa91d470291de2258d`
> 运行边界：本机 loopback MySQL、API、Worker、Web HTTPS 同源入口与 local provider stub；无生产凭据、部署或外网 provider。

## 自动化与安全证据

- 入口为 `pnpm test:e2e-scope-a`。每个已执行场景都由测试专用 lifecycle 创建随机小写 `RUN_ID`、独立 MySQL 容器、随机端口和 `E2E-<RUN_ID>` fixture，再由同一完整性校验所有权后停止和清理。
- `status` 冻结并校验 repository SHA、build/fixture identity、canonical migration、精确 fence profile、HTTPS/API/Worker/stub readiness。profile 无 blanket-all 入口；认证/Worker 前置只显式加入各场景所需的 `auth.commands` 与 `outbox.worker`。
- HTTPS proxy 只把 `/api/v1/*` 转发到 API；legacy `/api/*` 仍由 Web 处理，因此 C1 是实际同源 Web 证据，不是 API 直连替代。
- 请求 evidence 在断言中只保留路径、状态、error code 和 body SHA-256。报告不记录密码、OTP、cookie、token、DB URL、端口或 provider payload。

## 已执行场景

| 场景 | UI/API 证据 | MySQL / audit / outbox 证据 | 结果 |
| --- | --- | --- | --- |
| Identity / C1 | HTTPS login → local OTP stub → Secure cookie/CSRF → logout；无 CSRF fail-closed；受控 SMS `fail_once` 后 Worker retry；18/18 legacy GET 为 `410`、`WRITER_MOVED`、正确 Link | Worker 到 local stub；生命周期 profile/identity 复核 | PASS |
| R2 purchase plan | `201` create、同 key replay、变更 payload 的同 key `409 IDEMPOTENCY_KEY_REUSED` | plan、audit、approval-notification outbox 以稳定 entity/approval ID 查询 | PASS |
| R2 master data | SKU create、replay、key-reuse | SKU、`master_data` audit、approval-notification outbox | PASS |
| R2 supplier-SKU | 合法 relation write；supplier role 跨 scope `403` | relation、`suppliers` audit、approval-notification outbox | PASS |
| R2 purchase order | 从 fixture 的 confirmed plan + active supplier-SKU + effective price 创建；replay/key conflict | order、audit、domain-event outbox | PASS |
| R3 inventory / transfer / stocktake | reservation/replay；同仓调拨 `400`；跨仓 transfer 与可定位库存 target 的 stocktake open | reservation、精确 reservation audit、outbox | PASS |
| R3 production / quality | start → zero-complete（当前 handler 边界）；company-QC inspection；不平衡质量数量 `400` | execution-order audit/outbox | PASS；未验证 BOM 实物消耗或质量库存放行 |
| R3 shipment / return | HTTPS API：ship + same-key replay → admin receive → supply-chain return receive → admin inspect → factory propose → 独立 supply-chain review | shipment `received`，evidence/receipt/inspection/approved disposition 各 1；shipping/returns audit ≥6；delivery-batch/product-return domain-event outbox ≥6；生命周期清理 | PASS |
| R3 finance | `invalidate_invoice`；无 server-consumed step-up 的 `record_payment` `400 BAD_REQUEST` | invoice exception、finance audit、outbox | PASS；未执行 real payment |

## Blocked / 未覆盖

| 项目 | 状态和依据 |
| --- | --- |
| Approval/step-up 逐 effect 矩阵、职责分离 | 未覆盖；场景目录已标为业务裁决缺口，不猜测角色组合。 |
| R2 imports、supplier prices/performance、plan/order factory transition | 未覆盖；需要独立 fixture/已裁决状态而非猜测。 |
| Scope B | purchase receipt、BOM material consumption、quality inventory release、real provider/payment 均未进入。 |
| Worker poison-event | 未覆盖；本轮仅证明 local SMS `fail_once` 后 retry，不夸大为所有 provider/topic。 |

## 资源与身份

每次失败、skip 和成功场景均经 lifecycle 的精确 RUN_ID cleanup；最终检查要求无 `topology.e2e.run_id` 容器、无该 RUN_ID 临时目录/端口/拥有进程。所有代码和 fixtures 仅为测试用途，且仍线性基于 accepted baseline。

## 已运行门禁

| 命令 | 实际结果 |
| --- | --- |
| `pnpm test:e2e-scope-a` | **8 pass / 0 fail / 0 skip**；每个场景实际运行在 loopback MySQL/API/Worker/Web HTTPS/stub。 |
| `pnpm test:e2e-foundation` | **1 pass / 0 fail**；双 RUN_ID 同时存活、hostile env 隔离、OTP/control 隔离、PID tamper refusal、partial-start recovery 和 cleanup 均通过。 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test:non-mysql` | **387 pass / 0 fail / 0 skip**，Web system **4 pass / 0 fail**。 |
| `git diff --check` | PASS（最终提交前复核） |

本次获授权的两处生产修订仅将 INSERT 列名对齐冻结合同：`shipment_evidence.uploaded_at` → `created_at`，以及 `product_return_inspections.created_at` → `inspected_at`，均保留 `CURRENT_TIMESTAMP(3)`。物流 E2E 使用 Web `datetime-local` 的 `YYYY-MM-DDTHH:mm` 输入；RFC3339 `Z` 不在当前实现合同内。未改变 migration、schema、公共 API、业务规则或 Scope B 边界。
