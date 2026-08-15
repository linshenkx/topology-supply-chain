# Tier 1：现场 E2E 环境与就绪门

Tier 1 是真人/Agent 现场验收，不是业务场景的开箱即跑断言。缺少任一适用前置条件，场景状态只能为 `BLOCKED` 或 `HUMAN_CHECKPOINT`。功能代码锚点 `254e3a0` 沿用受控的本机 fixture、provider stub 与 HTTPS 底座，并新增整批收货/整批质检/生产真实预留三条闭环；它不决定业务状态机、职责分离或更复杂的业务扩展。

## 启动顺序（仅受控测试环境）

1. 选择唯一小写 `RUN_ID`（例如 `e2e-20260813-ab12`），在 Windows PowerShell 中先设置 `$env:RUN_ID = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$((New-Guid).ToString('N').Substring(0,8))"`，再执行 `pnpm e2e:prepare -- --run $env:RUN_ID --fence-profile <profile>`。基础用 `foundation-auth-worker`；三条业务闭环必须用 `t2-operations-scope-a-closures`（含 `r3.purchase-receipts.commands`、`r3.quality-inspections.commands`、`r3.inventory.commands`、`r3.production-orders.commands`）。它只创建 label 为 `topology.e2e.run_id=<RUN_ID>` 的 MySQL 8 临时容器/库，先复核 canonical migration，再 seed [版本化 Scope A pack](../../tests/e2e/fixtures/scope-a.fixture.json)。它不读取 `.env` 或生产凭据。fence profile 仅接受测试代码中的冻结精确 resource 集合，绝不存在全量启用入口。
2. 冻结安装与构建：`pnpm install --frozen-lockfile`、`pnpm build:contracts`、`pnpm build:api`、`pnpm build:worker`、`pnpm build:web:preview`。构建失败停止，不改源码或依赖。
3. 执行 `pnpm e2e:start -- --run $env:RUN_ID`，再执行 `pnpm e2e:status -- --run $env:RUN_ID`，并确认 `git rev-parse HEAD` 等于 `status.repositorySha`。运行时仅监听 `127.0.0.1`：stub、Worker、API、Web 和 HTTPS proxy 都采用各自随机端口。HTTPS 使用只在临时运行目录存在的一日自签名证书；浏览器必须在人工检查前显式信任或接受该测试证书。
4. `status` 必须同时确认当前 repository SHA、实际 build/entry identity、fixture JSON 与 seed module SHA、声明 profile 与数据库 writer-fence 状态、HTTPS、API/Worker ready、三类 stub health、canonical migration、已记录服务监听项/进程 owner 及 Docker label owner。任一失败即 `BLOCKED`，不得进入场景。

每个进程用独立 stdout/stderr 文件和带随机 owner token 的 wrapper PID 后台启动；停止/清理会先校验 wrapper 命令行的 `RUN_ID`、token 与 entry，状态文件被篡改、PID 重用或非 owner PID 会 fail-closed，绝不执行 `taskkill`。所有子进程使用显式安全环境 allowlist，清除宿主 provider URL/key、代理与生产凭据；仅注入 `127.0.0.1` stub URL。

## 认证、cookie 与 CSRF

真人从 Web 登录页提交 `POST /api/v1/auth/login`，body 为 `account`、`password`、`deviceId`（可选 `deviceName`），并携带唯一 `idempotency-key` 和与当前 origin 完全一致的 `Origin`。若结果为 OTP challenge，真人只能通过已授权的受控 SMS stub 或已分配测试手机取得 OTP；没有其中之一即 `HUMAN_CHECKPOINT`，不得从日志、数据库或 preview code 取码。

Agent 以 HTTPS 同源 cookie jar（仅内存）调用 API。读取 login command response 的 `result.challengeNo` 后，使用 `POST /api/v1/auth/verify`，body 为 `challengeNo`、6 位 `code`（可选 `deviceName`），同样带唯一 key 与同源 Origin。verify 成功时安全保留响应的 `topology_session`（HttpOnly）和 `topology_csrf` cookie；后续写操作把 `topology_csrf` 原值作为 `x-csrf-token`，并让 jar 自动发送两枚 cookie。不得把 cookie、OTP、Authorization、CSRF 或完整 Set-Cookie 写入命令行、文件、日志或 evidence。

`topology_session`/`topology_csrf` 目前均带 `Secure; SameSite=Strict`；标准浏览器在 plain `http://` 通常不会接收 Secure cookie。因此没有由环境管理员提供的受控 HTTPS loopback origin 或确认过的同等安全 cookie client 时，Agent/真人真实会话链为 `BLOCKED`，不能拿本地 preview 空会话替代。每次请求的 `Origin`、Host 与协议必须完全同源；不得伪造 `Host`、跨 origin 发送 cookie，或手工构造 session token。

## 账号与 fixture pack 合同

`tests/e2e/fixtures/scope-a.fixture.json` 是版本化逻辑 pack；`prepare` 使用现有 MySQL schema/handler 可见的字段生成每运行一份实际 ID manifest。账号密码、OTP、cookie、CSRF、DB URL、stub key 仅存在于仓库外运行状态，永不写入 manifest、日志或 Git。以[evidence manifest 模板](./templates/evidence-manifest.json)记录每次运行；其 `ready=true` 仅在以下内容全具备时成立：

- 账号：内部管理员/供应链、工厂（含 factory binding）、审批人、财务、无权角色；当前 fixture 只生成 admin/supply_chain/factory/approver/finance/denied，账号格式 `<role>.<RUN_ID>@e2e.invalid`，账号 owner、测试 OTP 路径及过期/轮换时间。独立 company_qc/supplier_qc 账号不在 fixture，需环境管理员额外授权，否则该身份 HUMAN_CHECKPOINT/BLOCKED。
- 范围：组织、factory、tiered supplier、SKU、有效 BOM、warehouse、库存 batch（含成品与组件 batch、可用/锁定/待检/隔离数量）、supplier-SKU 关系、有效价格与证据文件。
- 单据：可决策 pending approval（含 version/effect）、采购计划/item、采购订单/item（含 received_quantity 与唯一权威 plan link）、生产/execution order（含 production_material_lines）、质量规则（incoming 与 finished_goods）、整批收货待检批次、库存 reservation/transfer、stocktake、shipment、return、invoice/payment/exception 等每个要执行场景所需 ID 与版本。
- 支撑：测试上传文件/扫描结果、Outbox/Worker stub contract、数据库名/清理 owner、fixture SHA/生成时间/有效期。

`database/tooling/bootstrap-admin.mjs` 不是 E2E seed；生命周期不会调用它。

任一字段、权限关系、可清理证明或 fixture SHA 缺失时，停止相关 A1/R2/R3 场景。真人确认 UI 可见性时也必须引用同一 manifest；Agent 不能以猜测的 ID、状态或业务日期补齐。

## 生命周期与清理

`prepare → start → status → evidence → stop → cleanup` 是唯一稳定顺序。`evidence` 可选 `--out <safe-json-path>`；其内容符合模板且不含秘密。`cleanup` 先完成 PID owner 校验与停止，再核对 Docker label 后销毁容器/临时库，并删除证书和运行时日志。它绝不删除未知容器、卷、端口、数据库或文件。stub 的 `/control`、`/events` 同时要求 control token 与 RUN_ID；`/events` 只含不可逆的非秘密结构元数据，绝不含 payload hash 或 OTP oracle。`pnpm test:e2e-foundation` 验证双 RUN_ID 并发启动/状态、重复调用、部分启动失败恢复、Secure cookie/CSRF、OTP/control/events 隔离、hostile env 不出网、fixture/build/fence identity 与端口/PID/容器/临时目录清理归零；该测试不执行业务场景。`pnpm test:e2e-scope-a` 现在同时运行原 Scope A 场景与 [Stage 12 三条闭环 E2E](../../tests/e2e-scope-a-closures.integration.test.mjs)，覆盖整批收货、整批质检放行/隔离、生产真实预留/领料消耗/释放与对应负路径。
