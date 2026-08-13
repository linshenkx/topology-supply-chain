# Implementation Notes

## Source

- Stage 11 T1 delegation: create a local-only, repeatable Tier 1 E2E environment, fixture and provider-stub foundation without changing production contracts, schema, migrations, deployment, or Scope B.
- Bounded revision after candidate `3710803`: repair only the accepted PID ownership, environment isolation, stub event/OTP, fixture invariant, readiness identity/fence profile and lifecycle-regression findings.

## Design Decisions

- 以 Node 内置 HTTP/HTTPS、已锁定的 `mysql2`/Drizzle 和 Docker MySQL 8 实现；没有新增依赖或 lockfile 变更。
- 将全部状态、证书、秘密和日志置于操作系统临时目录；仓库仅保存版本化逻辑 fixture pack、生命周期代码、测试和文档。
- API 使用其现有 production-mode 安全 cookie/OTP/Worker-ready 路径，但所有 endpoints、数据库和 provider 均为 `127.0.0.1` 测试资源；没有改 production runtime。
- fixture 只插入现有 schema 默认/既有 handler 可见的 Scope A 对象，不定义新的状态机或 Scope B 行为。
- 有界修订以随机 owner-token wrapper + 独立临时 HMAC key 校验状态和 PID 所有权；状态篡改、PID 重用或不匹配命令行一律拒绝清理。
- 所有 E2E 子进程改用最小环境 allowlist；stub 事件改为 control-token + RUN_ID 保护的无秘密结构记录，避免 OTP 离线枚举 oracle。
- 就绪门冻结 repository、build/entry、fixture JSON/seed module、canonical migration 和测试专用 frozen writer-fence profile；profile 只能按精确命名资源启用。

## Deviations

- Windows 的 file URL 和后台日志文件句柄分别在首次集成测试中暴露；已改为本地路径和同步句柄，未改变应用合同。

## Tradeoffs

- 自签名 HTTPS 证书保证真实 `Secure` cookie 行为；真人浏览器仍需显式信任/接受该本机临时证书，底座不修改操作系统信任库。

## Open Questions

- T2 的职责分离、价格/绩效、采购/盘点/物流/财务业务裁决仍未授权，保持 blocked。

## Verification Notes

- Goal created before implementation; accepted baseline is `144d5395ac8bade1acb38c8911fa9248ce704201`.
- Frozen dependency installation completed with `--frozen-lockfile`; it did not modify the lockfile.
- `tests/e2e-foundation.integration.test.mjs`: PASS, 1/1, 0 fail/skip; verified two RUN_IDs, repeat prepare/start behavior, controlled stub failure/recovery, HTTPS Secure cookie + CSRF, OTP isolation, migration/fixture readiness and zero-residue cleanup.
- `pnpm typecheck`: PASS. `pnpm test:non-mysql`: PASS, 387/387, 0 fail/skip. Final lint and immutable identity/diff checks are run before commit.
- Bounded revision: `pnpm test:e2e-foundation` PASS (1/1, 0 fail/skip, 435.3s): concurrent two-RUN lifecycle, secure cookie/CSRF, OTP/control/events isolation, hostile inherited environment removal, PID/state tamper rejection, partial-start cleanup/retry, and resource zeroing.
- Bounded revision: lint, typecheck and `test:non-mysql` pass; frozen MySQL migration repository assertion passes. The current registry reports an unrelated pre-existing production audit advisory (`nanoid@3.3.17`, GHSA-2v37-7h3g-55p8); no dependency or lockfile was changed under this bounded authorization.
