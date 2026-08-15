# Agent 执行规程

Agent 只能在本地或明确授权的受控测试环境执行；不能自行取得凭据、打开公网服务、部署、push/PR、调用真实支付/OSS/provider，或修改生产代码、测试代码、配置、schema、migration、identity、Docker/deploy 文件。开始前必须先通过 [Tier 1 环境与 fixture 就绪门](./tier1-readiness.md)；仓库没有现成 fixture、账号或 provider stub 时，记录为 `BLOCKED` 或 `HUMAN_CHECKPOINT`。

## 变量、命名与进程

```powershell
$env:RUN_ID = "e2e-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$((New-Guid).ToString('N').Substring(0,8))"
$env:EVIDENCE_DIR = Join-Path (Get-Location) ("delivery/agent-uat/" + $env:RUN_ID)
$env:TEST_PREFIX = "E2E-$env:RUN_ID-"
# HTTPS/API/Worker origin 从同一 RUN_ID 的 e2e:status 读取，不得手写端口。
```

- origin 和端口必须来自同一 `RUN_ID` 的 `e2e:status`/evidence manifest。浏览器业务请求使用同源 HTTPS；API/Worker origin 只用于就绪核验。
- MySQL 必须是授权的 loopback 测试实例，数据库和测试数据以 `RUN_ID` 精确命名。
- 每个写操作生成 `<RUN_ID>-<scenario>-<ordinal>` 幂等键；只有字节等同重放才复用原键和 digest。
- 每条命令设置有界超时；禁止无限重试。一个已经验证可用的浏览器/启动方式应在本次验收中复用，不为测试载体重复排障。
- 不打印或落盘密码、Cookie、Authorization、CSRF、OTP、数据库 URL 查询串或 AccessKey。

## 执行流程

1. 创建 `EVIDENCE_DIR/{http,db,ui,logs}`，写入 `evidence-manifest.json` 初始字段；记录 HEAD、工作树和运行资源。
2. 以有限轮询检查 health 和 build identity；无法就绪时保存日志、标记 `BLOCKED`，停止后续写操作。
3. 按 [场景清单](./scope-a-scenarios.md) 和 [Stage 12 真人业务验收手册](./stage12-human-business-acceptance.md) 执行。已有自动化覆盖的负路径不在浏览器中机械重复；浏览器重点验证真实页面操作、状态反馈和关键业务链。
4. 每条关键链只保留必要步骤、3–5 张代表性截图，以及至少一种 API/DB/audit/outbox 证据。命令返回非预期状态不得被空断言或替换 fixture 掩盖。
5. 遇到 selector/fixture/角色缺失、业务预期未定义、超范围能力、真实 provider/部署/凭据需求或测试载体失败时，停止受影响场景并说明原因；测试载体失败不得判为产品功能 `FAIL`。
6. 非阻断问题只登记，不修改项目。完成后按 [真人清理规则](./human-execution.md#清理与回滚) 清理精确 RUN_ID 资源，确认端口、PID 和临时数据库状态。

## 结果与证据

证据遵守 [最低证据要求](./governance/evidence-protocol.md)。机器可读快照使用 [evidence manifest 模板](./templates/evidence-manifest.json)；问题使用 [issue 模板](./templates/issue.md)。

结果只允许 `PASS`、`PASS_WITH_ISSUES`、`FAIL`、`BLOCKED`、`HUMAN_CHECKPOINT`、`NOT_RUN`、`NOT_APPLICABLE`、`NEEDS_DECISION`。`PASS` 必须同时有预期和证据；`BLOCKED`/`HUMAN_CHECKPOINT` 必须有原因和交接对象；`FAIL` 必须保留首个失败响应和日志。禁止把未执行或 skip 写成 `PASS`。
