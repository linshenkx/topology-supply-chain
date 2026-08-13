# Tier 0：仓库可立即执行的自动化基线

Tier 0 只验证当前仓库的构建、静态检查和已命名测试；它不需要业务 fixture、真人账号或真实 provider，也不能证明 Tier 1 现场业务链已经就绪。Node.js 必须 `>=22.13.0`，pnpm 必须 `11.9.0`。

## 精确命令与通过条件

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:non-mysql
```

- `pnpm install --frozen-lockfile` 失败即停止；不得改 `package.json` 或 lockfile 来“修复”环境。
- `pnpm lint` 和 `pnpm typecheck` 的通过条件是退出码 `0`。
- `pnpm test:non-mysql` 的 runner 选择所有非 `.integration.test.mjs` 文件，skip 被视为失败。冻结基线 `84a409c` 的已记录结果为 **54 files、387 pass、0 fail、0 skip**；计数变化必须连同 SHA 和原因记录，不能自动当作绿灯。

每条命令总超时至少 10 分钟；不得用短同步超时截断。若执行器会回收前台子进程，使用一个后台父进程、独立 stdout/stderr 日志、PID 文件，以及最多 12 次、每次 5 秒的轮询；超限记 `FAIL`，附最后 200 行日志，不能无限重试。

## 可选 MySQL 门禁（不是现场 E2E）

只有环境管理员提供以下 **五个显式、loopback-only 测试 URL** 时才运行：

```powershell
$env:MYSQL_ADMIN_TEST_URL = '<redacted>'
$env:TEST_DATABASE_URL = '<redacted>'
$env:MYSQL_WRITE_TEST_URL = '<redacted>'
$env:MYSQL_R2_TEST_URL = '<redacted>'
$env:MYSQL_R3_TEST_URL = '<redacted>'
pnpm test:mysql
```

不提供任一 URL 时，状态是 `BLOCKED`，不是 skip、更不是 pass。测试 URL 仅可指向经授权的 loopback MySQL 8 临时库；使用唯一前缀、后台日志、有限轮询，并在结束后由管理员精确删除本次临时库。不得将 URL 或密码写入证据。Stage 10 T2 的已接受记录为 MySQL `8 files、21 pass、0 fail、0 skip`，MySQL 8.4.11 / REPEATABLE-READ、write/R2/R3 migration history 均 5/5；复用该历史证据不等于本次现场重跑。

## Tier 0 输出

在 evidence manifest 中记录 SHA、命令、开始/结束时间、退出码、files/pass/fail/skip（若有）、日志路径和资源状态。Tier 0 失败先停止；Tier 0 通过后仍必须通过[Tier 1 环境就绪门](./tier1-readiness.md)才可执行真人/Agent 场景。
