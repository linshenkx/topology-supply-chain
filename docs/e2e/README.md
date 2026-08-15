# Scope A 真人与 Agent E2E 验收手册

> 术语说明：R2/R3 沿用 Scope A 写迁移两批命令的历史代号（R2=供应侧 12 命令，R3=履约财务侧 13 命令）；代码已改用领域名 supply/operations，冻结的 r2.*/r3.* 命令名与 writer resource 不变。Stage 12 新增 r3.purchase-receipts.commands。

> 功能代码锚点：254e3a0de1a3ef812c7487550f1ae7d8d0e7a61a（Stage 12 业务闭环的最终代码提交）；本 docs/e2e 是其 docs-only 后代。实际 UAT 必须记录 git rev-parse HEAD，且该值等于 e2e:status.repositorySha。Stage 10/11 历史报告保留在 docs/refactor/，是历史证据。
> 适用环境：本机或受控测试环境。不得连接生产、使用生产凭据、调用真实 provider，或执行部署。

## 执行入口

1. 先执行 [Tier 0 自动化基线](./tier0-automation.md)。
2. Tier 1 先以本地测试底座创建独立 RUN_ID（PowerShell：$env:RUN_ID = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$((New-Guid).ToString('N').Substring(0,8))"，随后 pnpm e2e:prepare/start/status -- --run $env:RUN_ID），再过 [环境与 fixture 就绪门](./tier1-readiness.md)，由业务验收人按 [真人执行规程](./human-execution.md) 确定角色、样本和签字范围。
3. 自动化执行者还必须完整遵守 [Agent 执行规程](./agent-execution.md)，并使用 [请求模板](./request-templates.md) 与 [fixture/evidence 模板](./templates/fixture-manifest.json)。
4. 逐项执行 [Scope A 场景清单](./scope-a-scenarios.md) 与 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md)。每项都要有 HTTP、数据库或审计/Outbox 中至少一种可复核证据；UI 没有稳定 selector 或夹具时，不得假装自动化完成。

## 环境和边界

- 只允许 loopback（127.0.0.1 / localhost）服务、临时测试数据和受控 MySQL 8 容器。tooling/e2e/lifecycle.mjs 为每个 RUN_ID 创建带 Docker label 的独立容器/库、运行时 HTTPS 证书和仓库外日志；cleanup 只会删除匹配该 label 与状态文件的资源。URL、数据库名和日志目录必须在证据清单中记录，但不得记录密码、cookie、OTP 或访问密钥。
- Web/API/Worker 均监听随机 loopback 端口，统一由 status.origins 提供；浏览器业务请求使用 HTTPS 同源入口，API/Worker origin 仅用于生命周期就绪核验。API 健康检查为 /api/v1/health/live 与 /api/v1/health/ready。在受控 aliyun-runtime 配置中，/api/health 在 OSS 或数据库不可用时应返回受控 503 与 degraded，不得泄露凭据。
- 所有 R2/R3 写命令都使用独一无二的 idempotency-key；同一业务动作的重放才复用同一个 key 和完全相同的请求，换请求内容不得复用 key。
- Stage 12 已实现且应人工验证：整批收货、整批质检放行/隔离、生产真实预留/领料消耗/释放剩余预留。仍超范围（不执行也不判定通过）：部分收货、冲销、供应商退货、MRP/多批次分配/替代补退料/排产、拆批/部分放行/复检/让步/返工报废/成本责任、完整 MES/ERP/税务/银行/实时物流、工厂协同大屏、生产级 AI、真实 provider、生产部署/凭据。

## 最小证据包

每次运行创建一个只含测试数据的运行标识 RUN_ID，并保存到仓库内 gitignored 相对目录 .\e2e-runtime\evidence\<RUN_ID>\（prose 写作 e2e-runtime/evidence/<RUN_ID>/；不要写 /e2e-runtime，Windows 下会被解析为 C:\e2e-runtime）：

- manifest.json：环境、版本、角色、命令和结果摘要；格式见 Agent 规程。
- http/：脱敏后的请求摘要、响应状态和 command metadata；不得保存会话、CSRF、OTP 或密钥。
- db/：只查询本次 RUN_ID 关联记录的输出，或经人工签字的查询截图；至少包括业务记录、audit_logs、outbox_messages 的关联证据。
- ui/：人工检查截图，并标明页面、时间、操作者、可见角色和检查点；截图不含个人数据或密钥。
- logs/：Web/API/Worker 的后台日志尾部及退出码。失败必须保留日志和停止原因，不可删除后重跑掩盖失败。

## 场景覆盖与判定

| 编号 | 场景 | 执行方式 | 通过门槛 |
| --- | --- | --- | --- |
| A1 | 登录、OTP、Step-up、角色/组织范围 | 真人 + API/DB | 身份、对象绑定和拒绝路径均可取证 |
| A2 | 审批批准、拒绝、重放 | 真人 + API/DB | 仅 pending 可决策；重复或越权 fail-closed |
| R2 | 主数据、供应商、采购、导入 preview-stage-commit | API 优先，UI 人工检查 | command metadata、范围和导入归属可取证 |
| R3 | 库存、调拨、盘点、生产/质检、发货/退货、财务当前边界 | API 优先，UI 人工检查 | 现有 schema/状态边界、审计和 Outbox 可取证 |
| S12-A | 采购单→整批收货→待检批次 | 真人 + API/DB | 唯一权威分配、整批守恒、待检批次与审计可取证 |
| S12-B | 待检批次→整批质检→放行/隔离 | 真人 + API/DB | 整批 pass/fail、库存放行/隔离与审计可取证；fixture 中由 admin 以 company_qc 判定 |
| S12-C | 生产真实预留→领料/消耗→释放/完工（C1/C2 独立） | 真人 + API/DB | 预留/消耗/释放守恒、零预留 409 零副作用可取证；C1=reserve→materials→release、C2=reserve→materials→complete 使用两个独立 RUN_ID，不冒充同一连续浏览器链 |
| P1 | 幂等、digest、fence、unknown outcome | API/测试夹具 | replay 一致；冲突和不确定结果不静默成功 |
| P2 | audit、Outbox、Worker retry/重复投递 | API/DB/Worker 日志 | 仅验证当前实现的可观察边界；不调用 provider |
| C1 | 18 个旧 GET 退役 | API | 精确 410、WRITER_MOVED、successor Link |
| C2 | OSS 缺失时 Web health | 受控本地配置 | 受控 503；不以预览运行时替代该证据 |

场景的具体步骤、失败判断和人工检查点在 [Scope A 场景清单](./scope-a-scenarios.md)；三条闭环的逐页面必验步骤在 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md)；结果填写与签字使用 [UAT 结果与签字模板](./templates/uat-signoff.md)。任何“未验证”“业务裁决”或“超范围”项都只能记录为未通过验收范围，不能以测试绿灯替代。
