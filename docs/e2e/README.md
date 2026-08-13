# Scope A 真人与 Agent E2E 验收手册

> 验收基线：`59a36fa6bab3a3349b4225faf677b2506ad60c53`；父链含 Stage 10 T1/T2。
> 适用环境：本机或受控测试环境。不得连接生产、使用生产凭据、调用真实 provider，或执行部署。

本目录把已有合同和测试证据转成可重复的验收步骤，不宣称已完成业务全闭环。它严格分为两层：可立即运行的[Tier 0 自动化基线](./tier0-automation.md)，和必须先通过就绪门的[Tier 1 现场 E2E](./tier1-readiness.md)。当前能力和已知缺口以[基础业务能力—测试覆盖矩阵](../business-capability-test-matrix.md)为准；本轮最终结论见[Stage 10 最终验收报告](../refactor/stage10-e2e-final-acceptance.md)。

## 执行入口

1. 先执行[Tier 0 自动化基线](./tier0-automation.md)。
2. Tier 1 先以本地测试底座创建独立 `RUN_ID`（`pnpm e2e:prepare -- --run <RUN_ID>`、`pnpm e2e:start -- --run <RUN_ID>`、`pnpm e2e:status -- --run <RUN_ID>`），再过[环境与 fixture 就绪门](./tier1-readiness.md)，由业务验收人按[真人执行规程](./human-execution.md)确定角色、样本和签字范围。
3. 自动化执行者还必须完整遵守[Agent 执行规程](./agent-execution.md)，并使用[请求模板](./request-templates.md)与[fixture/evidence 模板](./templates/fixture-manifest.json)。
4. 逐项执行[Scope A 场景清单](./scope-a-scenarios.md)。每项都要有 HTTP、数据库或审计/Outbox 中至少一种可复核证据；UI 没有稳定 selector 或夹具时，不得假装自动化完成。

## 环境和边界

- 只允许 loopback（`127.0.0.1` / `localhost`）服务、临时测试数据和受控 MySQL 8 容器。`tooling/e2e/lifecycle.mjs` 为每个 `RUN_ID` 创建带 Docker label 的独立容器/库、运行时 HTTPS 证书和仓库外日志；`cleanup` 只会删除匹配该 label 与状态文件的资源。URL、数据库名和日志目录必须在证据清单中记录，但不得记录密码、cookie、OTP 或访问密钥。
- Web 位于 `:3000`，API 位于 `:3001`，Worker 位于 `:3002`；API 的健康检查为 `/api/v1/health/live` 和 `/api/v1/health/ready`。在受控 aliyun-runtime 配置中，`/api/health` 在 OSS 或数据库不可用时应返回受控 `503` 与 `degraded`，不得泄露凭据。
- 所有 R2/R3 写命令都使用独一无二的 `idempotency-key`；同一业务动作的重放才复用同一个 key 和完全相同的请求，换请求内容不得复用 key。R2 key 长度为 16–128 且符合 Contracts 规定的字符集。
- Scope B：Purchase Receipt、BOM 实际预留/领料/消耗、质检驱动库存放行/隔离、真实支付、真实 provider、生产部署/凭据。它们均不执行也不判定通过。

## 最小证据包

每次运行创建一个只含测试数据的运行标识 `RUN_ID`，并保存：

- `evidence/<RUN_ID>/manifest.json`：环境、版本、角色、命令和结果摘要；格式见 Agent 规程。
- `http/`：脱敏后的请求摘要、响应状态和 `command` metadata；不得保存会话、CSRF、OTP 或密钥。
- `db/`：只查询本次 `RUN_ID` 关联记录的输出，或经人工签字的查询截图；至少包括业务记录、`audit_logs`、`outbox_messages` 的关联证据。
- `ui/`：人工检查截图，并标明页面、时间、操作者、可见角色和检查点；截图不含个人数据或密钥。
- `logs/`：Web/API/Worker 的后台日志尾部及退出码。失败必须保留日志和停止原因，不可删除后重跑掩盖失败。

## 场景覆盖与判定

| 编号 | 场景 | 执行方式 | 通过门槛 |
| --- | --- | --- | --- |
| A1 | 登录、OTP、Step-up、角色/组织范围 | 真人 + API/DB | 身份、对象绑定和拒绝路径均可取证 |
| A2 | 审批批准、拒绝、重放 | 真人 + API/DB | 仅 pending 可决策；重复或越权 fail-closed |
| R2 | 主数据、供应商、采购、导入 preview-stage-commit | API 优先，UI 人工检查 | command metadata、范围和导入归属可取证 |
| R3 | 库存、调拨、盘点、生产/质检、发货/退货、财务当前边界 | API 优先，UI 人工检查 | 现有 schema/状态边界、审计和 Outbox 可取证 |
| P1 | 幂等、digest、fence、unknown outcome | API/测试夹具 | replay 一致；冲突和不确定结果不静默成功 |
| P2 | audit、Outbox、Worker retry/重复投递 | API/DB/Worker 日志 | 仅验证当前实现的可观察边界；不调用 provider |
| C1 | 18 个旧 GET 退役 | API | 精确 `410`、`WRITER_MOVED`、successor Link |
| C2 | OSS 缺失时 Web health | 受控本地配置 | 受控 `503`；不以预览运行时替代该证据 |

场景的具体步骤、失败判断和人工检查点在[Scope A 场景清单](./scope-a-scenarios.md)。任何“未验证”“业务裁决”或“Scope B”项都只能记录为未通过验收范围，不能以测试绿灯替代。
