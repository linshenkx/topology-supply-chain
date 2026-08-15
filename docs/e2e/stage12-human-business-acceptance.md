# Stage 12 真人业务验收手册（浏览器 UAT）

## 1. 文档定位与基线

- 本手册是 topology-supply-chain 收口阶段 D1 的真人浏览器/UAT 结果，把旧 docs/e2e 收口为可直接执行的业务验收手册。
- 功能代码锚点：254e3a0de1a3ef812c7487550f1ae7d8d0e7a61a（Stage 12 三条业务闭环的最终代码提交）。本手册是功能锚点 254e3a0 的 docs-only 后代链；实际执行 SHA 动态记录（git rev-parse HEAD），且必须等于 e2e:status.repositorySha。
- 实际 UAT 执行不写死上述任一 SHA：环境管理员/执行者必须记录 git rev-parse HEAD，且该值必须等于 e2e:status 输出的 repositorySha；两者不一致即 BLOCKED。
- Stage 12 代码父链（三段闭合）：254e3a0 ← 59e1fb1 ← 736f104 ← cdfe87c。三段提交的主题、范围与自动化验收证据见 [Scope A 业务闭环最小设计](../scope-a-business-closure-design.md)。
- 来源主任务 threadId：019ff47b-64cb-7233-9a73-c6728ef839bb。本手册是 D1 唯一结果所有者的 docs-only 交付，不授权修改生产/测试代码、package/lock、migration/schema、Docker/部署配置、delivery 目录或历史 Stage 报告。
- 术语：R2/R3 是 Scope A 写迁移两批命令的历史代号（R2=供应侧，R3=履约财务侧）；代码已改用领域名 supply/operations，冻结的 r2.*/r3.* 命令名与 writer resource 不变。purchase.receive 属于 R3 侧新增命令，writer resource 为 r3.purchase-receipts.commands。

## 2. 验收结论分类（先读，避免误判）

### 2.1 已实现且应人工验证

- 登录 / OTP / Step-up、工作台可见性、主数据、供应商、采购计划/采购单/整批收货、导入、库存/预留/调拨/盘点、生产单/真实预留/领料消耗/释放/完工、来料与成品质检、发货/退货、财务、审批与系统管理。
- Stage 12 三条业务闭环：整批收货、整批质检放行/隔离、生产真实预留/领料消耗/释放剩余预留。

### 2.2 自动化已覆盖但仍需人工观察

- 幂等重放、digest/key 冲突拒绝、writer fence、unknown outcome fail-closed、CSRF/同源、审计、Outbox、Worker stub 投递，以及三条闭环的负路径（重复、越权、冻结、零预留释放、部分收货拒绝、整批质检约束）。
- 旧 18 个业务 GET 精确 410 退役、受控 OSS 缺失 Web health 503。
- 连续浏览器 E2E（tests/e2e-scope-a-closures.integration.test.mjs）覆盖生产预留 → 领料/消耗 → 释放剩余预留；生产完工 complete 是独立人工检查点，未由该连续浏览器 E2E 覆盖（见 9.3）。
- 这些已由 pnpm test:non-mysql、pnpm test:mysql、pnpm test:e2e-foundation、pnpm test:e2e-scope-a 覆盖；真人仍需在浏览器里至少观察一次 UI 提示与刷新后状态，不能只以自动化绿灯替代签字。

### 2.3 明确未实现/超范围（不得作为首期必测）

- 部分收货、超短收、冲销、供应商退货；MRP、多批次分配、替代/补退料、排产；拆批、部分放行、复检、让步、返工报废、成本责任。
- 完整 MES/ERP、税务、银行、实时物流；工厂协同大屏；生产级 AI；真实 provider；生产部署与生产凭据。
- Web 内“工作台”“工厂协同”“AI助手”是演示看板，不构成通过项；只做可见性观察。

## 3. 安全边界与红线

- 只允许 loopback（127.0.0.1 / localhost）服务、临时测试数据和受控 MySQL 8 容器。
- 禁止连接生产、使用生产凭据、调用真实 SMS/支付/OSS/provider、执行部署或 push/PR。
- 证据中不得出现密码、cookie、Authorization、CSRF、OTP、数据库 URL 查询串、AccessKey、stub control token、otpToken。
- RUN_ID 只允许小写 e2e- 开头（生命周期正则 ^e2e-[a-z0-9][a-z0-9-]{5,80}$），例如 e2e-20260815-d1ab12。

## 4. 启动、状态与清理命令（Windows PowerShell 为主）

生命周期只能在本机受控环境执行，顺序固定为 prepare → start → status → evidence → stop → cleanup。

```powershell
$env:RUN_ID = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$((New-Guid).ToString('N').Substring(0,8))"
pnpm e2e:prepare -- --run $env:RUN_ID --fence-profile t2-operations-scope-a-closures
pnpm e2e:start -- --run $env:RUN_ID
pnpm e2e:status -- --run $env:RUN_ID
$evidenceManifest = Join-Path (Get-Location) ("e2e-runtime\evidence\" + $env:RUN_ID + "\evidence-manifest.json")
pnpm e2e:evidence -- --run $env:RUN_ID --out $evidenceManifest
pnpm e2e:stop -- --run $env:RUN_ID
pnpm e2e:cleanup -- --run $env:RUN_ID
```

执行前必须核对实际 repositorySha 与运行态一致（不一致即 BLOCKED）：

```powershell
$head = git rev-parse HEAD
$status = pnpm e2e:status -- --run $env:RUN_ID | ConvertFrom-Json
if ($head -ne $status.repositorySha) { throw "repositorySha mismatch: $head vs $($status.repositorySha)" }
```

仅 WSL / Git Bash 环境的备用命令（与上表不混用）：

```bash
export RUN_ID="e2e-$(date +%Y%m%d-%H%M%S)-$(printf '%04x' $RANDOM)-$(printf '%04x' $RANDOM)"
pnpm e2e:prepare -- --run "$RUN_ID" --fence-profile t2-operations-scope-a-closures
pnpm e2e:start -- --run "$RUN_ID"
pnpm e2e:status -- --run "$RUN_ID"
pnpm e2e:evidence -- --run "$RUN_ID" --out "./e2e-runtime/evidence/$RUN_ID/evidence-manifest.json"
pnpm e2e:stop -- --run "$RUN_ID"
pnpm e2e:cleanup -- --run "$RUN_ID"
```

- prepare 只创建带 topology.e2e.run_id=<RUN_ID> label 的 MySQL 8 临时容器/库，复核 canonical migration 后 seed 版本化 Scope A pack [scope-a.fixture.json](../../tests/e2e/fixtures/scope-a.fixture.json)，不读 .env 或生产凭据。
- fence profile 只接受冻结的精确 resource 集合；三条闭环使用 t2-operations-scope-a-closures（含 auth.commands、outbox.worker、r3.purchase-receipts.commands、r3.quality-inspections.commands、r3.inventory.commands、r3.production-orders.commands）。
- status 必须确认：repository SHA、build/entry identity、fixture JSON 与 seed module SHA、fence profile 与 writer-fence 状态、HTTPS、API/Worker ready、三类 stub health、canonical migration、监听项/PID/Docker label owner。任一失败即 BLOCKED。
- 运行时 origin 全部来自 status.origins：https（浏览器/业务请求统一入口）、api、worker。所有端口随机，不得手写 :3000/:3001/:3002。HTTPS 使用一次性自签名证书，浏览器需先信任或接受该测试证书。
- 生命周期运行态位于仓库外 %TEMP%\topology-e2e\<RUN_ID>\（state.json、logs、manifest.json、evidence-manifest.json）；cleanup 只删除匹配该 RUN_ID label 与状态的资源。

## 5. 角色、账号与测试数据命名

当前 fixture 只生成以下 6 个账号，格式为 <role>.<RUN_ID>@e2e.invalid：

| 账号 | 说明 | 可用于 |
| --- | --- | --- |
| admin | 系统管理员 | 系统管理、审批、整批质检（以 inspectorType=company_qc 判定） |
| supply_chain | 供应链 | 主数据/供应商/采购/库存/生产/收货等 R2+R3 命令 |
| factory | 组装工厂（带 factory binding） | 工厂确认、工厂范围读写、整批收货（绑定权威工厂） |
| approver | 供应链审批人（fixture 中同 supply_chain role） | 审批决策 |
| finance | 财务 | 财务命令，对收货等越权应 403 |
| denied | 供应商角色（非 supplier_qc） | 越权负路径 |

- 独立 company_qc / supplier_qc 账号不在当前 fixture。整批质检在当前 fixture 由 admin 以 inspectorType=company_qc 执行（handler 允许 admin 走 company_qc 判级；UI 允许 admin/company_qc 操作待检批次）。
- 若验收方要求真人以真实 company_qc 或 supplier_qc 身份签字，环境管理员必须额外授权对应账号并写入 fixture manifest；否则该身份只能是 human-checkpoint 或 BLOCKED。supplier_qc 路径还要求该账号绑定到目标 supplier。
- 所有测试组织、工厂、供应商、SKU、BOM、仓库、批次、单据名称使用 E2E-<RUN_ID>- 前缀；fixture 实际生成 E2E-<RUN_ID> 相关实体（详见 [fixture 模板](./templates/fixture-manifest.json)）。
- 三条闭环必需 fixture 实体：confirmed 采购单与 finished 明细、唯一采购计划分配（factory/warehouse）、活动工厂仓库、组件库存批次、approved active BOM、planned execution order、生产物料行、incoming/finished_goods 两条 quality rule（最低合格率 9500 bps）。

### 5.1 可执行登录与 OTP 读取（环境管理员）

随机 password、otpToken 与数据库 URL 只存在于 %TEMP%\topology-e2e\<RUN_ID>\state.json。环境管理员仅在本地临时 PowerShell 会话读取，禁止 Start-Transcript、写日志/evidence、命令行硬编码或复制到文档；任何秘密只能短暂出现在内存/控制台。

**第 1 步：读取本地 state 的账号与随机密码（不要重新生成 RUN_ID）**

```powershell
# 复用第 4 节 prepare 前已设置并用于本次启动的 $env:RUN_ID；不要在 OTP 阶段重新生成。
$statePath = Join-Path $env:TEMP ("topology-e2e\" + $env:RUN_ID + "\state.json")
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$account = "admin.$env:RUN_ID@e2e.invalid"   # 按需替换为 <role>.<RUN_ID>@e2e.invalid
$password = $state.password
$otpToken = $state.secrets.otpToken
$stubPort = $state.resources.ports.stub
# 秘密仅保留在本临时 PowerShell 会话内存；禁止 Transcript/日志/evidence/命令行硬编码。
```

**第 2 步：真人先在浏览器提交登录并看到 challenge**

浏览器打开 `e2e:status.origins.https`，用 `$account` 与 `$password`（仅显示在控制台，不复制）提交登录；看到 OTP challenge 页面后停下并保持页面打开。未看到 challenge 前不得读取 `/otp`。

**第 3 步：challenge 出现后，有界轮询 loopback `/otp`（最多 80 次 × 250ms）**

```powershell
$code = $null
$attempts = 0
while ($attempts -lt 80) {
  $attempts++
  try {
    $resp = Invoke-WebRequest -Method Get -Uri ("http://127.0.0.1:" + $stubPort + "/otp?runId=" + $env:RUN_ID) -Headers @{ "x-e2e-otp-token" = $otpToken } -TimeoutSec 2
    $json = $resp.Content | ConvertFrom-Json
    $code = $json.code
    break
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    if ($status -eq 404) {
      Start-Sleep -Milliseconds 250
      continue
    }
    throw "OTP stub unexpected status: $status"
  }
}
if (-not $code) { throw "OTP stub timeout after 80x250ms" }
```

`GET /otp` 要求 `x-e2e-otp-token` 与查询 `runId` 同时匹配；404 表示尚无可用 code（继续有界轮询），403/其他非 404 错误必须立即失败，不继续轮询；80 次仍无 code 即超时并 `BLOCKED`。

**第 4 步：显示临时 code 供真人输入，浏览器 verify 成功后再清理**

```powershell
Write-Host "Temporary OTP code (enter in browser): $code"
# 真人立即在浏览器输入并完成 verify；确认登录成功后再执行清理：
Remove-Variable password, otpToken, stubPort, code, account, state, resp, json -ErrorAction SilentlyContinue
```

- 每次 `/otp` 读取会消费当前验证码（随后再次读取返回 404），code 只用一次且短期有效，不得重复轮询到第二个 code 后继续使用旧值。
- 若没有环境管理员提供上述本地读取通道，真人 OTP 环节只能是 human-checkpoint/BLOCKED，不得从日志、数据库或 preview code 取码。

## 6. 证据目录与取证

人工采集证据统一写入仓库内 gitignored 相对目录 .\e2e-runtime\evidence\<RUN_ID>\（prose 写作 e2e-runtime/evidence/<RUN_ID>/）：

```text
e2e-runtime/evidence/<RUN_ID>/
├── manifest.json          # 环境、SHA、角色、命令与结果摘要
├── http/                  # 脱敏请求摘要/响应状态/command metadata
├── db/                    # 本次 RUN_ID 的业务记录、audit_logs、outbox_messages
├── ui/                    # 页面截图：页面、时间、操作者、可见角色、检查点
└── logs/                  # Web/API/Worker 日志尾部与退出码
```

注意：不要写 /e2e-runtime/...（Windows 下会被解析为 C:\e2e-runtime）。路径一律使用相对仓库根目录的 .\e2e-runtime\evidence\<RUN_ID>\ 或 e2e-runtime/evidence/<RUN_ID>/。

每条可复核证据至少覆盖 HTTP、DB 业务事实、audit、outbox 四类之一。写操作成功响应必须含 command.command、command.idempotencyKey、command.requestDigest、command.replayed；首发应为 replayed:false，字节等同重放才允许 true。

## 7. NO-GO / 阻断判定

出现任一即为 NO-GO 候选（仅在负向路径被场景明确期望时，401/403/409/503 才可能是通过）：

- HTTP 非预期；越权却成功；相同请求无法重放；换 digest 未被拒绝；写入无审计/Outbox；数据越出组织/工厂范围；响应泄露凭据。
- 缺少受控 HTTPS 同源会话、测试账号/OTP stub、授权测试 MySQL、fixture manifest，或 status 任一就绪检查失败。
- repositorySha 与 git rev-parse HEAD 不一致；company_qc/supplier_qc 无授权账号却声称已按该身份签字。
- UI 无稳定 selector/夹具却声称“UI 自动化通过”；以本地 preview 空数据替代真实 DB 证据。

## 8. 分页面人工验收清单

每个页面记录：入口、可见角色、操作者、观察结果、HTTP/DB/audit/outbox 证据路径。下表“演示/不判通过”列只做可见性观察，不进入业务通过项。

| 页面（导航） | 已实现且应验证 | 关键负路径 | 演示/不判通过 |
| --- | --- | --- | --- |
| 登录 | 账号密码登录 → OTP challenge → 核验；锁定阈值；Step-up 绑定对象/版本 | 错码、过期、换对象、5 次锁定 | — |
| 工作台 | 登录后可见性；只显示当前角色可访问入口 | 无权角色不看到受限数据 | 静态生产看板、待办/风险卡片 |
| 采购管理 | 采购计划/采购单/整批收货；计划确认、下单核对、工厂确认、24h 采购单确认 | 越权、部分收货 400、重复收货 409 | — |
| 供应商管理 | 供应商、supplier-SKU、价格、绩效 | 越权范围、Step-up 价格激活 | — |
| 物料与补料 | SKU/BOM 主数据 | 越权、非法 BOM 版本 | — |
| 执行单 | 生产单创建/开工/物料实绩/释放预留；完工为独立检查点 | 超权威分配、BOM 不生效、冻结、越权 | — |
| 生产质检 | 待检批次整批放行/隔离、质检记录（fixture 中由 admin 以 company_qc 判定） | 部分/抽样/混合判、来源歧义、越权 | — |
| 发货管理 | 发货/收货/异常 | 越权、缺证据文件 | — |
| 库存管理 | 库存/预留/调拨/盘点 | 冻结、负数、超量 | — |
| 财务结算 | 发票/付款/更正/退款/风险释放 | 高风险需 Step-up、越权、超付 | 禁止真实支付 |
| 审批中心 | 批准/拒绝/重放、高风险 Step-up | 仅 pending、重复/越权 fail-closed | — |
| 系统管理 | 用户/角色/解锁/审计 | 职责分离、越权 | — |
| 工厂协同 / AI助手 | — | — | 静态演示，不判通过 |

具体步骤、字段与 API/DB 断言以 [Scope A 场景清单](./scope-a-scenarios.md) 与 [请求模板](./request-templates.md) 为准；三条闭环的逐页面必验步骤见下一节。

## 9. Stage 12 三条业务闭环（逐页面必验）

通用前置：完成 Tier 0 与 [Tier 1 就绪门](./tier1-readiness.md)，RUN_ID、fixture manifest、角色与 stub provider 齐备。

### 9.1 闭环 A：采购单 → 整批收货 → 待检库存批次

#### 前置 fixture

- confirmed 采购单 purchaseOrderId、finished 明细 orderItemId（数量 10、received_quantity=0）。
- 该明细只有唯一一条 purchase_plan_order_links，且 purchase_plan_items 的 factory_id/warehouse_id 唯一一致；收货仓库 status=active，未被盘点冻结。

#### 操作者

- admin / supply_chain / 绑定该权威工厂的 factory。财务等无权角色应被拒绝。

#### UI 步骤

1. 进入「采购管理 → 正式采购单」，展开目标采购单。
2. 明细行显示“已收货 0/10”、唯一“收货仓库 #<id>”与“整批收货”按钮。
3. 点击“整批收货”，弹窗显示产品、待收货数量、收货仓库。
4. 点击“确认整批收货”。

#### 预期提示与刷新后状态

- 提示“采购明细 <sku> 已整批收货，进入待检批次”。
- 刷新后明细变为“已收货 10/10”，按钮变为“已收货”；「生产质检」待检批次出现该批次（来源 incoming）。

#### 预期 API/HTTP

- POST /api/v1/purchase-receipts，body {purchaseOrderId, orderItemId, warehouseId, receivedQuantity?}；receivedQuantity 省略或等于剩余数量。
- 成功 201，command.command="purchase.receive"，result.receipt 含 id/receiptNo/purchaseOrderId/orderItemId/warehouseId/batchId/receivedQuantity。

#### DB 业务事实

- purchase_receipts 新增一行（order_item_id 唯一）；order_items.received_quantity 增加为 10。
- inventory_batches 新增一行（batch_no=RCV-<orderNo>-<orderItemId>-<uuid>，pending_inspection_quantity=10，ownership=company）。
- inventory_movements 新增 inbound 行，source_key=purchase_receipt:<receiptId>。

#### audit / outbox

- audit_logs：module=purchase_receipts、action=receive、entity_type=purchase_receipt。
- outbox_messages：PurchaseOrderItemReceived（aggregate_type=purchase_receipt，dedup key r3:*）。

#### 负路径

- 部分收货：receivedQuantity 不等于剩余 → 400（Only full-batch receipt is supported）。
- 重复收货：新 key 再收同一明细 → 409（order_item_id 唯一/已收货）。
- 无唯一权威分配或多工厂/仓库 → 409；收货仓库非权威仓库 → 409；仓库冻结 → 409；非 confirmed 采购单 → 409。
- 越权：finance → 403；非绑定 factory → 403。
- 幂等：同 key 同 body 重放 → 201 且 replayed:true，不新增业务副作用。

### 9.2 闭环 B：待检批次 → 整批质检 → 放行/隔离

#### 前置 fixture

- 闭环 A 产生的待检批次（pending_inspection_quantity>0），或生产完工产生的成品待检批次。
- 存在与该 SKU/stage 匹配的 active quality rule（incoming 或 finished_goods，minimum_pass_rate_bps=9500）。

#### 操作者

- 当前 fixture：admin 以 inspectorType=company_qc 执行整批判定。
- 若验收方要求真实 company_qc 身份签字，需环境管理员额外授权 company_qc 账号；supplier_qc 整批路径当前 fixture 无对应账号，缺账号时 human-checkpoint/BLOCKED。

#### UI 步骤

1. 进入「生产质检」，读取“待检库存批次”（GET /api/v1/quality-inspections/pending-batches，仅 admin/company_qc）。
2. 目标行显示批次号、SKU、仓库、来源（来料/成品完工）、待检数量。
3. 点“整批合格”或“整批不合格”；不合格需填写不合格原因。

#### 预期提示与刷新后状态

- “整批合格，已转入可用库存”或“整批不合格，已转入隔离库存”。
- 刷新后该批次从待检列表消失；“最近质检”出现 finalResult=passed|failed。

#### 预期 API/HTTP

- POST /api/v1/quality-inspections，body {batchId, stage, inspectionMethod:"full", batchQuantity, inspectedQuantity, passedQuantity, failedQuantity, inspectorType:"company_qc", defectReason?}。
- 整批必须 batchQuantity=inspectedQuantity=pending，且 passedQuantity/failedQuantity 其一等于 pending、另一个为 0；不合格时 defectReason 必填。
- 成功 201，result.inspection 含 id/batchId/stage/inspectionMethod/passRateBps/qualityRuleId/systemResult/finalResult/requiresApproval/fullInspectionRequired/version。

#### DB 业务事实

- quality_inspections 新增一行，batch_id 指向该批次。
- 合格：批次 pending_inspection_quantity→0、available_quantity += inspectedQuantity，movement inspection_pass。
- 不合格：批次 pending_inspection_quantity→0、quarantine_quantity += inspectedQuantity，movement inspection_fail。

#### audit / outbox

- audit_logs：module=quality、action=submit、entity_type=quality_inspection。
- outbox_messages：合格 InspectionCompleted；不合格 DispositionRequired。

#### 负路径

- 部分/抽样：batchQuantity/inspectedQuantity 不等于 pending → 400；inspectionMethod 非 full → 400；合格+不合格混合 → 400。
- 来源歧义或缺失：批次既非唯一 receipt 又非唯一 production → 409；来源与 stage 不匹配（receipt 批用 finished_goods 或反之）→ 409。
- 无待检数量 → 409；无 active quality rule → 409；不合格缺 reason → 400；越权 inspectorType → 403。
- 幂等：同 key 同 body 重放 → replayed:true；换 key 再判同批次 → 409。

### 9.3 闭环 C：生产单 + 真实预留 → 领料/消耗 → 释放 / 完工（C1 与 C2 独立执行）

#### 前置 fixture

- confirmed 采购单 finished 明细 + 唯一权威计划分配；approved active BOM 且 PO 下单日在 BOM 有效期；execution_order（planned）与 production_material_lines。
- 组件库存批次（可用数量充足），并已通过 POST /api/v1/inventory 建立 entity_type=production_order 的 active reservation。
- 默认 fixture 只有一个 executionOrderId。因此 C1（reserve→materials→release）与 C2（reserve→materials→complete，不先 release）必须使用两个独立 RUN_ID，各自 prepare/start/status/evidence/stop/cleanup，且 repositorySha、fenceProfile、HTTPS origin 读取规则相同。只有环境管理员额外提供第二个 execution order 时才可在同一 RUN_ID 内继续 C2；否则不得要求当前默认 fixture 在同一 RUN_ID 有第二单。

#### 操作者

- admin / supply_chain / 绑定生产工厂的 factory。

#### C1：reserve → materials → release（独立 RUN_ID，连续浏览器证据）

1. 「库存管理」执行预留（或按 API 执行 POST /api/v1/inventory）。
2. 「执行单」选择生产单 → “开工”（start）。
3. 展开“物料”，填写实际领料/消耗/损耗 → “保存实绩”（materials）。
4. 点“释放预留”（release_materials）释放剩余预留。

预期提示与刷新后状态：

- “生产已开始”“物料实绩已保存”“剩余预留已释放”。
- 刷新后生产单状态：planned → in_production（release 不改变状态）；库存批次 locked 回落、available 回升；movement production_release。

#### C2：reserve → materials → complete（独立 RUN_ID，不先 release）

在另一个独立 RUN_ID 中重新 prepare/start 得到全新的默认 fixture（同一唯一 executionOrderId），在同一单上完成 reserve→materials→complete，且不要在 complete 前执行 release：

1. 建立预留 → 开工（start）。
2. 保存物料实绩（consumed+loss ≤ issued，且不超过 active 预留）。
3. 点“完工”（complete），输入实际完工数量 actualFinishedQuantity。
4. 刷新后状态：无偏差且 actual>0 → completed，生成 production_report 与成品待检批次（PROD-...，pending_inspection_quantity=actual）；有偏差 → variance_pending 并生成 production_variance 审批。

正数完工（actualFinishedQuantity=2）已有 MySQL 自动化证据（apps/api/test/mysql-scope-a-closures.integration.test.mjs，app.inject），但这不是连续浏览器 E2E，不能冒充真人连续浏览器证据；也不得把 C1 与 C2 冒充同一连续浏览器链（C2 是独立 RUN_ID 的独立人工检查点）。

#### 预期 API/HTTP

- POST /api/v1/inventory {batchId, entityType:"production_order", entityId, requestedQuantity, priority?} → 201。
- PATCH /api/v1/production-orders：
  - {id, action:"start"} → 200。
  - {id, action:"materials", materials:[{id, issuedQuantity, consumedQuantity, lossQuantity}]} → 200；consumed+loss ≤ issued，领用不得超过“已消耗+已损耗+active 预留”。
  - {id, action:"release_materials"} → 200，返回 releasedQuantity/version。
  - {id, action:"complete", actualFinishedQuantity, companyInventoryQuantity?, factoryOwnedQuantity?, materials?} → 200。

#### DB 业务事实

- 预留：inventory_reservations active 增加；批次 available-=qty、locked+=qty。
- 领料消耗：production_material_lines 更新 issued/consumed/loss；reservation reserved_quantity-=delta、状态到 0 变 consumed；批次 locked-=delta；movement production_consumption。
- 释放：剩余 active reservation → reserved_quantity=0,status=released；批次 locked-=remaining, available+=remaining；movement production_release。
- 完工（无偏差且实际>0）：production_reports 新增，execution_orders.status=completed，创建成品待检批次（PROD-...，pending_inspection_quantity=actual），movement inbound_pending_inspection；有偏差则 status=variance_pending 并生成 production_variance 审批。

#### audit / outbox

- audit_logs：module=production，action 分别为 create/start/materials/release_materials/complete；预留侧为 module=inventory。
- outbox_messages 精确事件名：ProductionOrderCreated、ProductionOrderStarted、ProductionMaterialsReported、ProductionReservationReleased、ProductionOrderCompleted、ProductionVarianceRequested（complete 无偏差 → ProductionOrderCompleted；有偏差 → ProductionVarianceRequested）。

#### 负路径

- 无 active 预留即释放 → 409（No active reservations to release）；纯零数量 active reservation 释放 → 409 且零副作用（254e3a0 修复）。
- 领料数量下降 → 409；领用超过 active 预留 → 409；consumed+loss>issued → 409；冻结 → 409；越权 factory → 403。
- 已 release 后再报正数领用/完工 → 409（Issued quantity exceeds real inventory reservations）。
- 幂等：materials/release_materials 同 key 同 body 重放 → replayed:true；释放后再次用新 key 释放 → 409。

### 9.4 清理与结果填写

- pnpm e2e:stop -- --run $env:RUN_ID 后保存日志尾部与退出码；pnpm e2e:cleanup -- --run $env:RUN_ID 精确清理 Docker 容器/临时库/证书/运行态。
- 按 RUN_ID/E2E-<RUN_ID>- 复核业务、audit、outbox 记录已清零，或记录未清理原因与责任人。
- 结果填入 [UAT 结果与签字模板](./templates/uat-signoff.md)，每个场景必须给出 pass/fail/blocked/human-checkpoint 与证据路径。

## 10. 明确未实现/超范围清单

以下仍在本阶段之外，不得写成“首期必测”或“通过项”：

- 部分收货、超短收、冲销、供应商退货。
- MRP、多批次分配、替代/补退料、排产。
- 拆批、部分放行、复检、让步、返工报废、成本责任。
- 完整 MES/ERP、税务、银行、实时物流。
- 工厂协同大屏、生产级 AI、真实 provider、生产部署与生产凭据。
- 演示看板：工作台静态看板、工厂协同、AI助手。

## 11. 结果填写与签字

逐场景结果与签字使用 [UAT 结果与签字模板](./templates/uat-signoff.md)。签字前必须满足：git status --short 干净、repositorySha 与 git rev-parse HEAD 一致、证据在 gitignored 目录、无秘密落盘、BLOCKED/NO-GO 项已写明原因与交接对象。

## 12. 文档索引

- [e2e README](./README.md)：入口与执行顺序。
- [Tier 0 自动化基线](./tier0-automation.md)、[Tier 1 就绪门](./tier1-readiness.md)。
- [真人执行规程](./human-execution.md)、[Agent 执行规程](./agent-execution.md)。
- [Scope A 场景清单](./scope-a-scenarios.md)、[请求模板](./request-templates.md)。
- [Scope A 业务闭环最小设计](../scope-a-business-closure-design.md)：Stage 12 三段提交与自动化验收证据。
- 历史 Stage 10/11 与 reviews 报告在 ../refactor/，是历史证据，不改写。
