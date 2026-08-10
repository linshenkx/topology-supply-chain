# Stage 1 Implementation Notes

## Source

- 用户要求停止继续扩写方案并开始实际实施。
- 本阶段已落地四个独立切片：生产身份边界、登录 MFA、财务 Step-up/审批抢占、库存调拨原子化；同时修复阿里云构建边界。
- 基线：`codex/refactor-planning@2523b40`；实施分支：`codex/refactor-stage1`。

## Design Decisions

- 正式身份统一以应用自身签发的 Session Cookie 为准；`oai-authenticated-user-*` 不再作为任何运行时的登录凭据。
- 本地预览管理员只允许在非 `APP_ENV=production`、非 `DEPLOY_TARGET=aliyun`、非 `NODE_ENV=production` 且请求主机为回环地址时启用。
- 阿里云 Nginx 在登录入口和通用入口都显式清空三类上游身份头，形成代理层与应用层双重防线。
- 登录接口复用同一生产边界，禁止用伪造回环主机名跳过短信；可信设备和登录验证码有效期在数据库查询中比较，避免 MySQL 无时区文本被 Node 按本地时区误解析。
- 登录和 Step-up OTP 的成功验证使用 `verified_at IS NULL` 条件 CAS，错误次数由数据库原子递增；可信设备 upsert 在运行时兼容 D1 与 MySQL 方言。
- 高风险证明绑定用户、用途、动作与具体业务 ID，验证后由服务端条件删除并检查受影响行数；客户端布尔值不再具有授权含义。
- 审批 proof 消费与 `pending → approved/rejected` CAS 位于同一生产事务；只有抢占成功的请求可继续执行业务副作用。
- 库存调拨发出与收货都以数据库条件更新抢占状态；发出时每个批次还必须满足 `available_quantity >= 本次扣减量`，任何一步未恰好影响一行即返回 `409` 并由生产 MySQL 事务回滚。
- 阿里云构建通过跨平台脚本固定 `APP_ENV=production`、`DEPLOY_TARGET=aliyun`，并把 `outputs/**` 归档副本排除在 TypeScript 与 ESLint 边界之外。

## Deviations

- 原定仅修身份头；用户授权直接推进开发后，范围扩展到同一批审计确认的认证、财务验证、审批并发、库存并发和生产构建 P0，不包含完整前后端拆分。

## Tradeoffs

- 任何曾依赖 OpenAI/Sites 身份头的远程预览会改为 `401`，必须使用已有账号密码登录流程；仓库中的正式前端本就使用 `/api/auth/login` 与 Session，该取舍不会影响本地回环预览。
- 本地 D1 预览不具备与生产 MySQL 相同的事务回滚语义；调拨防并发的生产保证以 `DEPLOY_TARGET=aliyun` 下的真实 MySQL 事务为准。
- 普通审批目前仍是“先提交审批 CAS，再执行跨域业务副作用”；重复执行已阻止，但后续副作用失败仍可能留下审批状态与业务实体不一致，必须在领域服务拆分时继续收口。

## Open Questions

- 付款登记的已付总额仍在事务外汇总，可被两份独立有效 proof 并发超额；在该切片关闭前，系统仍为生产 No-Go。
- 密码失败锁定、调拨与盘点冻结、真实 MySQL 双连接测试和迁移演练仍未完成。
- 全仓 `pnpm lint` 仍有 28 个存量错误，主要是既有 React Hook 写法与宽泛类型；本阶段不把大面积前端机械改写混入安全提交。

## Verification Notes

- `node --test tests/access-boundary.test.mjs`：5/5 通过。
- `pnpm exec eslint app/lib/access-boundary.ts app/lib/authz.ts tests/access-boundary.test.mjs`：通过。
- `git diff --check`：通过。
- `node --test tests/inventory-transfer-guard.test.mjs`：5/5 通过。
- `pnpm exec eslint app/lib/inventory-transfer-guard.ts app/api/inventory/transfers/route.ts tests/inventory-transfer-guard.test.mjs`：通过。
- `node --test tests/login-mfa-boundary.test.mjs`：3/3 通过。
- `pnpm exec eslint app/api/auth/login/route.ts app/api/auth/verify/route.ts tests/login-mfa-boundary.test.mjs`：通过。
- Step-up、审批 CAS、OTP CAS、跨方言 upsert 相关测试：18/18 通过；定向 ESLint 通过。
- 构建边界测试：2/2 通过。
- `pnpm build:aliyun`：通过编译、TypeScript、页面数据收集及 36 个页面/路由生成。
- 真实 MySQL 双连接并发测试尚未执行；在上线门禁中仍为必做项。
- `pnpm lint`：失败，28 个存量错误；未发现本轮服务端与新增测试的定向 ESLint 错误。
