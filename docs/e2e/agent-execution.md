# Agent 执行规程

Agent 只能在本地或明确授权的受控测试环境执行；不能自行取得凭据、打开公网服务、部署、push/PR、调用真实支付/OSS/provider，或修改生产代码、测试代码、配置、schema、migration、identity、Docker/deploy 文件。开始前必须先通过[Tier 1 环境与 fixture 就绪门](./tier1-readiness.md)；仓库没有现成 fixture/账号/provider stub 时，状态只能是 `BLOCKED`/`human-checkpoint`。

## 变量、命名与进程

```powershell
$env:RUN_ID = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$((New-Guid).ToString('N').Substring(0,8))"
$env:EVIDENCE_DIR = Join-Path (Get-Location) ("e2e-runtime/evidence/" + $env:RUN_ID)
$env:TEST_PREFIX = "E2E-$env:RUN_ID-"
# HTTPS/API/Worker origin 从同一 RUN_ID 的 e2e:status 读取，不得手写端口：
#   HTTPS_ORIGIN = status.origins.https
#   API_ORIGIN = status.origins.api
#   WORKER_ORIGIN = status.origins.worker
```

- origin 和端口必须来自同一 RUN_ID 的 `e2e:status`/evidence manifest，不得手写固定端口。浏览器/API 业务请求统一使用 `HTTPS_ORIGIN`；`API_ORIGIN` 与 `WORKER_ORIGIN` 只用于生命周期就绪核验。只接受 `127.0.0.1` 或 `localhost` origin；若变量解析为其他 host，停止并写明原因。MySQL 必须是经授权的 loopback 测试实例，且数据库/测试数据以 `RUN_ID` 精确命名。
- 每个写操作生成 `<RUN_ID>-<scenario>-<ordinal>` idempotency key。只有字节等同的重放复用原 key 和 digest；任何 body、目标、身份或 header 变化都生成新 key。
- 启动进程必须后台运行、重定向 stdout/stderr 至 `EVIDENCE_DIR/logs/`，保存 PID 和启动命令（不含秘密）。每条 HTTP 命令指定连接和总超时；轮询最多 12 次、间隔 5 秒，超限即失败并停止。不得无限重试或把超时改为成功。
- 不打印或落盘密码、cookie、Authorization、CSRF、OTP、数据库 URL 查询串、AccessKey。证据只保留变量名、主机、端口、SHA 和脱敏摘要。

## 自动化流程

1. 创建 `EVIDENCE_DIR/{http,db,ui,logs}`，写入 `manifest.json` 的初始字段；读取并记录 `git rev-parse HEAD`、`git status --short` 和所有运行进程/端口。
2. 先以有限轮询检查 health；无法就绪时保留日志、标为 blocked/failed，停止后续写操作。
3. 逐项执行[场景清单](./scope-a-scenarios.md)，三条业务闭环（S12-A/S12-B/S12-C）的逐页面必验步骤与角色以 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md) 为准。每次请求保存：场景 ID、方法、路径、脱敏 header 名、body 的 SHA-256、状态、响应 body 的 SHA-256、command metadata 和时间。命令返回非期望状态不能被 shell `|| true`、空断言或替换 fixture 掩盖。
4. 仅针对当前 `RUN_ID` 查询业务、audit、Outbox 证据。Worker 只能对测试消息或 stub 运行；失败重试与重复投递以已有消息/日志为证，不可手工伪造成功状态。
5. 一旦遇到稳定 selector 缺失、数据夹具缺失、业务期望未定义、明确未实现/超范围能力、真实 provider/部署/凭据需求或自动化失败：停止该场景，写入 `humanCheckpoint` 或 `blockedReason`，交由真人检查；不得猜测预期或将其计为 pass。
6. 停止本次进程，按[真人清理规则](./human-execution.md#清理与回滚)清理精确前缀资源；确认端口/PID/临时数据库状态并写入 manifest。

## 证据文件格式

`manifest.json` 至少符合以下形状（示例值是占位符）：

```json
{
  "runId": "<RUN_ID>",
  "gitSha": "<sha>",
  "environment": { "web": "https://127.0.0.1:<port>", "api": "https://127.0.0.1:<port>", "worker": "http://127.0.0.1:<port>" },
  "scenarios": [{ "id": "A1", "status": "pass|fail|blocked|human-checkpoint", "evidence": ["http/A1-01.json"], "humanCheckpoint": null }],
  "resources": { "pids": [], "ports": [], "testPrefix": "E2E-...-", "cleanup": "complete|not-needed|blocked" },
  "secretsRecorded": false
}
```

`pass` 必须同时有预期结果和证据文件；`blocked`/`human-checkpoint` 必须有原因和交接对象；`fail` 必须保留首个失败的响应和日志。禁止出现“未执行但 pass”“skip 当 pass”“重试后覆盖原失败”或缺失清理状态。
