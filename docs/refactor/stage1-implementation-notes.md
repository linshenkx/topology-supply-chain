# Stage 1 Implementation Notes

## Source

- 用户要求停止继续扩写方案并开始实际实施。
- 本次最小范围：修复生产入口可伪造 `oai-authenticated-user-email` 冒充有效用户的问题，补负向测试并本地提交。
- 基线：`codex/refactor-planning@2523b40`；实施分支：`codex/refactor-stage1`。

## Design Decisions

- 正式身份统一以应用自身签发的 Session Cookie 为准；`oai-authenticated-user-*` 不再作为任何运行时的登录凭据。
- 本地预览管理员只允许在非 `APP_ENV=production`、非 `DEPLOY_TARGET=aliyun`、非 `NODE_ENV=production` 且请求主机为回环地址时启用。
- 阿里云 Nginx 在登录入口和通用入口都显式清空三类上游身份头，形成代理层与应用层双重防线。
- 库存调拨发出与收货都以数据库条件更新抢占状态；发出时每个批次还必须满足 `available_quantity >= 本次扣减量`，任何一步未恰好影响一行即返回 `409` 并由生产 MySQL 事务回滚。

## Deviations

- 无。

## Tradeoffs

- 任何曾依赖 OpenAI/Sites 身份头的远程预览会改为 `401`，必须使用已有账号密码登录流程；仓库中的正式前端本就使用 `/api/auth/login` 与 Session，该取舍不会影响本地回环预览。
- 本地 D1 预览不具备与生产 MySQL 相同的事务回滚语义；调拨防并发的生产保证以 `DEPLOY_TARGET=aliyun` 下的真实 MySQL 事务为准。

## Open Questions

- 无阻塞问题；若修复需要改变本地预览产品行为，将采用显式环境开关并记录。

## Verification Notes

- `node --test tests/access-boundary.test.mjs`：5/5 通过。
- `pnpm exec eslint app/lib/access-boundary.ts app/lib/authz.ts tests/access-boundary.test.mjs`：通过。
- `git diff --check`：通过。
- `node --test tests/inventory-transfer-guard.test.mjs`：5/5 通过。
- `pnpm exec eslint app/lib/inventory-transfer-guard.ts app/api/inventory/transfers/route.ts tests/inventory-transfer-guard.test.mjs`：通过。
- 真实 MySQL 双连接并发测试尚未执行；在上线门禁中仍为必做项。
- 全仓 `tsc` 会扫描既有 `outputs/**` 归档副本并因其缺失依赖报错；该问题早于本切片且不由本补丁引入。
