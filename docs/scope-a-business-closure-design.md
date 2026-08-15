# Scope A 业务闭环最小设计（周末业务闭环阶段）

> 基线：`736f104e51c52b37459166085fdcf9bc7c18b5ae`（isolated worktree，detached HEAD，clean）。
> 结果所有者：本阶段唯一写入者；来源主任务 threadId=`019ff47b-64cb-7233-9a73-c6728ef839bb`。

## 结论

在现有统一 command executor、权限、审计、Outbox、幂等、MySQL transaction/CAS 与 Scope A E2E 底座上，
把三条既有能力缺口收敛为正常业务闭环：

- A：已有采购单明细 → 一次整批收货 → 一个待检库存批次。
- B：待检库存批次 → 一次整批质检 → 全合格转可用 / 全不合格转隔离。
- C：已有生产单 + 已有 BOM + 单一足量库存批次 → 库存预留 → 登记领料/消耗 → 释放剩余预留。

三条链路复用同一套 inventory batch/reservation/movement 账本，不新建第二套数据模型。

## 数据库（append-only，只新增 0005）

1. `purchase_receipts`：整批收货幂等事实；`order_item_id` 唯一，防止重复收货重复记账。
2. `order_items.received_quantity`：默认 0，收货后等于 `quantity`。
3. `quality_inspections.execution_order_id` 允许 NULL，新增 `batch_id`：来料质检以批次为对象。
4. 不新增生产物料表字段：生产预留仍由现有 `inventory.reserve` 建 `inventory_reservations`，按 BOM 组件 SKU 关联。

0000–0004 的 SQL、snapshot、journal、hash 原样不变；新增 migration/manifest 身份按 drizzle 生成流更新。

## 命令与路由

- `purchase.receive` → `POST /api/v1/purchase-receipts`，writer resource `r3.purchase-receipts.commands`。
- `quality.inspection.submit` 扩展：可传 `batchId`（incoming 整批），成功即完成批次放行/隔离。
- `manufacturing.order.transition` 扩展：`materials` 行动真实消耗已预留库存；新增 `release_materials` 释放剩余预留。
- 预留本身复用既有 `inventory.reserve`（entityType=`production_order`）。

## 不变量

- 数量非负且守恒：available + locked + pending_inspection + quarantine 每批守恒；预留/消耗/释放都在同一事务内 CAS。
- 状态转换受 `SELECT ... FOR UPDATE` 与条件 UPDATE 保护；重复 action 因业务唯一键/条件更新失败。
- `release_materials` 在产生 version/audit/outbox/movement 前必须确认正数可释放量 > 0；纯零数量 active reservation（`inventory.reserve` 缺货记录）稳定返回 409 且零副作用，不改变 inventory.reserve 缺货语义。
- 关键成功写入同事务产生幂等记录、审计与 domain event/outbox。
- 沿用身份、角色、组织范围、CSRF/同源、writer fence；无旁路。

## 排除（只记录，不实施）

部分/超短收、冲销、供应商退货；MRP、多批次分配、替代/补退料、排产；拆批、部分放行、复检、让步、返工报废、
成本责任；完整 MES/ERP/税务/银行/实时物流/工厂协同看板/生产 AI；生产部署与真实 provider。

## 验收（本阶段已完成，受控 loopback MySQL/API/Worker/Web HTTPS/stub）

- pnpm typecheck、pnpm lint、pnpm lint:baseline（0 errors / 0 warnings）、pnpm build:all：通过。
- pnpm test:non-mysql：395 pass / 0 fail / 0 skip。
- pnpm test:mysql：30 pass / 0 fail / 0 skip（9 个 MySQL 集成文件；含新增 closure MySQL 集成测试）。
- pnpm test:e2e-foundation：1 pass / 0 fail / 0 skip。
- pnpm test:e2e-scope-a：9 pass / 0 fail / 0 skip（新增业务闭环 E2E + 原 Scope A E2E 共 9 个 top-level 测试）。
- pnpm audit:policy、pnpm architecture:check、pnpm docker:check-context、pnpm deploy:check-env-contract、pnpm db:verify-generation：通过。
- 旧 migration 0000-0004 哈希不变；0005 append-only；git diff --check clean；本任务创建的 Docker 容器/进程/端口/运行时目录已清零；临时 MySQL 密码未进入仓库。
- 受控浏览器交互：supply_chain 整批收货、company_qc 来料质检、factory 真实预留后领料/消耗/释放与重复释放反馈，已在 loopback 栈经 Chrome DevTools 执行；证据（工作树内、.gitignore 排除）：e2e-runtime/browser-evidence/e2e-t2-browser-1786756810398/evidence.md。

证据（本机临时日志，仓库外 %TEMP%\scopea-mysql-gate\）：

- MySQL 全量：mysql-full-2.out.log
- E2E foundation：e2e-foundation.out.log
- E2E scope-a：e2e-scope-a.out.log
- 单文件回归：worker-replay.out.log、mds-single.out.log
