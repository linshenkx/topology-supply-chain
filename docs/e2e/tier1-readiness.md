# Tier 1：现场 E2E 环境与就绪门

Tier 1 是真人/Agent 现场验收，不是仓库开箱即跑功能。缺少任一适用前置条件，场景状态只能为 `BLOCKED` 或 `HUMAN-CHECKPOINT`；不可创建假账号、seed、provider 或更改配置来补齐。

## 启动顺序（仅受控测试环境）

1. 从 `.env.example` 建立**不入库**的本地环境文件，由环境管理员填入测试值。只记录变量类别，不记录值：会话/OTP sealing（`SESSION_SECRET`、`API_SESSION_SIGNING_KEY`、`OTP_SEALING_*`）、受控 MySQL（`DATABASE_URL`、DB timeout/TLS）、Worker provider webhook 的 URL/API key/health URL、以及需要时 `WORKER_INTERNAL_URL`。
2. 冻结安装与构建：`pnpm install --frozen-lockfile`、`pnpm build:contracts`、`pnpm build:api`、`pnpm build:worker`、`pnpm build:web:preview`。构建失败停止，不改源码或依赖。
3. 启动 Worker（必须先有受控测试 MySQL 和管理员提供的 SMS/email/file-scan stub；仓库没有 stub 启动命令）：`pnpm --filter @topology/worker start`。默认 `HOST=0.0.0.0`、`PORT=3002`；验收只能从 `127.0.0.1:3002/health/live` 和 `/health/ready` 探测，ready 非 `200` 即 BLOCKED。
4. 启动 API：`pnpm --filter @topology/api start`，默认 `PORT=3001`。非 production 的 Tier 1 必须由管理员显式提供当前 domain 注册模块环境值 `DOMAIN_REGISTRATION_MODULES=../modules/r2-master-procurement/index.js,../r3/manifest.js`；否则 R2/R3 路由并不保证注册。探测 `http://127.0.0.1:3001/api/v1/health/live` 与 `/ready`，ready 非 `200` 即停止。生产模式要求 `WORKER_INTERNAL_URL`，本手册不启动生产模式。
5. 启动 Web：`pnpm --filter @topology/web start:preview`（或为观察 UI 使用 `pnpm dev`）。默认 Web 端口以启动日志为准，不能硬编码为 3000；只有进程实际监听后才记录 origin。`GET /api/health` 的 OSS 缺失负向检查仅在受控 aliyun-runtime 进行，普通 preview `200` 不替代该证据。

每个进程用独立 stdout/stderr 文件和 PID 后台启动；对每个 health 最多轮询 12 次、间隔 5 秒。停止顺序：Web → API → Worker，然后由管理员按 `RUN_ID` 清理测试库资源；禁止杀死不属于本次 PID 的进程。

## 认证、cookie 与 CSRF

真人从 Web 登录页提交 `POST /api/v1/auth/login`，body 为 `account`、`password`、`deviceId`（可选 `deviceName`），并携带唯一 `idempotency-key` 和与当前 origin 完全一致的 `Origin`。若结果为 OTP challenge，真人只能通过已授权的受控 SMS stub 或已分配测试手机取得 OTP；没有其中之一即 `HUMAN-CHECKPOINT`，不得从日志、数据库或 preview code 取码。

Agent 以 HTTPS 同源 cookie jar（仅内存）调用 API。读取 login command response 的 `result.challengeNo` 后，使用 `POST /api/v1/auth/verify`，body 为 `challengeNo`、6 位 `code`（可选 `deviceName`），同样带唯一 key 与同源 Origin。verify 成功时安全保留响应的 `topology_session`（HttpOnly）和 `topology_csrf` cookie；后续写操作把 `topology_csrf` 原值作为 `x-csrf-token`，并让 jar 自动发送两枚 cookie。不得把 cookie、OTP、Authorization、CSRF 或完整 Set-Cookie 写入命令行、文件、日志或 evidence。

`topology_session`/`topology_csrf` 目前均带 `Secure; SameSite=Strict`；标准浏览器在 plain `http://` 通常不会接收 Secure cookie。因此没有由环境管理员提供的受控 HTTPS loopback origin 或确认过的同等安全 cookie client 时，Agent/真人真实会话链为 `BLOCKED`，不能拿本地 preview 空会话替代。每次请求的 `Origin`、Host 与协议必须完全同源；不得伪造 `Host`、跨 origin 发送 cookie，或手工构造 session token。

## 账号与 fixture pack 合同

仓库没有统一 E2E seed/fixture pack。环境管理员必须交付已版本化、与当前 SHA 绑定的[fixture manifest 模板](./templates/fixture-manifest.json)，并以[evidence manifest 模板](./templates/evidence-manifest.json)记录每次运行；其 `ready=true` 仅在以下内容全具备时成立：

- 账号：内部管理员/供应链、工厂（含 factory binding）、审批人、财务、无权角色；账号 owner、测试 OTP 路径及过期/轮换时间。
- 范围：组织、factory、tiered supplier、SKU、有效 BOM、warehouse、库存 batch、可用/锁定/待检数量、supplier-SKU 关系、有效价格与证据文件。
- 单据：可决策 pending approval（含 version/effect）、采购计划/item、采购订单/item、生产/execution order、质量、库存 reservation/transfer、stocktake、shipment、return、invoice/payment/exception 等每个要执行场景所需 ID 与版本。
- 支撑：测试上传文件/扫描结果、Outbox/Worker stub contract、数据库名/清理 owner、fixture SHA/生成时间/有效期。

`database/tooling/bootstrap-admin.mjs` 只能在交互式 MySQL 环境中创建**首位**管理员及其审计记录；已有 active admin 时拒绝，且它不创建组织范围、工厂绑定、供应商、SKU、库存、审批、财务对象、OTP provider 或完整 E2E fixture。它不是 seed，不得用于绕过本门。

任一字段、权限关系、可清理证明或 fixture SHA 缺失时，停止相关 A1/R2/R3 场景。真人确认 UI 可见性时也必须引用同一 manifest；Agent 不能以猜测的 ID、状态或业务日期补齐。
