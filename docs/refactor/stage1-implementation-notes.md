# Stage 1 Implementation Notes

## Source

- 用户要求停止继续扩写方案并开始实际实施。
- 本阶段已落地：生产身份边界、登录 MFA/锁定计数、财务 Step-up/审批抢占、付款账本并发、库存调拨原子化，以及阿里云构建边界。
- 基线：`codex/refactor-planning@2523b40`；实施分支：`codex/refactor-stage1`。

## Design Decisions

- 正式身份统一以应用自身签发的 Session Cookie 为准；`oai-authenticated-user-*` 不再作为任何运行时的登录凭据。
- 本地预览管理员只允许在非 `APP_ENV=production`、非 `DEPLOY_TARGET=aliyun`、非 `NODE_ENV=production` 且请求主机为回环地址时启用。
- 阿里云 Nginx 在登录入口和通用入口都显式清空三类上游身份头，形成代理层与应用层双重防线。
- 登录接口复用同一生产边界，禁止用伪造回环主机名跳过短信；可信设备和登录验证码有效期在数据库查询中比较，避免 MySQL 无时区文本被 Node 按本地时区误解析。
- 登录和 Step-up OTP 的成功验证使用 `verified_at IS NULL` 条件 CAS，错误次数由数据库原子递增；可信设备 upsert 在运行时兼容 D1 与 MySQL 方言。
- 密码错误次数使用数据库端封顶递增；正确密码清零使用旧值 CAS，不能覆盖并发发生的第五次失败锁定。
- 高风险证明绑定用户、用途、动作与具体业务 ID，验证后由服务端条件删除并检查受影响行数；客户端布尔值不再具有授权含义。
- 审批 proof 消费与 `pending → approved/rejected` CAS 位于同一生产事务；只有抢占成功的请求可继续执行业务副作用。
- 库存调拨发出与收货都以数据库条件更新抢占状态；发出时每个批次还必须满足 `available_quantity >= 本次扣减量`，任何一步未恰好影响一行即返回 `409` 并由生产 MySQL 事务回滚。
- 所有会改变付款净额或退款/补票余额的路径统一按“请款单 ID 升序 → 发票异常单 ID 升序”获取 MySQL 行锁；锁内重读、校验、消费 proof/审批 CAS、写账本并重算状态。
- 可支付净额只包含原始付款和不关联退款异常的更正/冲正；退款及退款更正不污染已付余额，且退款加补票不得超过异常影响金额。
- 阿里云构建通过跨平台脚本固定 `APP_ENV=production`、`DEPLOY_TARGET=aliyun`，并把 `outputs/**` 归档副本排除在 TypeScript 与 ESLint 边界之外。

## Deviations

- 原定仅修身份头；用户授权直接推进开发后，范围扩展到同一批审计确认的认证、财务验证、审批并发、库存并发和生产构建 P0，不包含完整前后端拆分。

## Tradeoffs

- 任何曾依赖 OpenAI/Sites 身份头的远程预览会改为 `401`，必须使用已有账号密码登录流程；仓库中的正式前端本就使用 `/api/auth/login` 与 Session，该取舍不会影响本地回环预览。
- 本地 D1 预览不具备与生产 MySQL 相同的事务回滚语义；调拨防并发的生产保证以 `DEPLOY_TARGET=aliyun` 下的真实 MySQL 事务为准。
- 真实财务账本写入在非阿里云 MySQL 环境会 fail closed；本地预览仍走无真实副作用的 preview 响应。
- 普通审批目前仍是“先提交审批 CAS，再执行跨域业务副作用”；重复执行已阻止，但后续副作用失败仍可能留下审批状态与业务实体不一致，必须在领域服务拆分时继续收口。

## Open Questions

- 系统整体仍为生产 No-Go：银行流水缺少数据库唯一幂等键，审计写入在业务提交之后，Step-up 尚未绑定金额/流水/对象版本与请求摘要。
- `invalidateInvoice`、`releaseInvoiceRisk`、调拨与盘点冻结仍有状态竞态；普通审批跨域副作用仍未与审批状态处于同一事务。
- 财务前端余额来自最近 300 条流水，大数据量下可能不同于后端全账本聚合；API 需要返回权威聚合值。
- 真实迁移、备份恢复、全业务 MySQL 并发和回滚演练仍未完成。
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
- 登录密码并发锁定相关测试：4/4 通过，与认证组合测试合计 10/10 通过。
- 付款、退款、补票、更正锁序与账本规则相关测试：10/10 通过；所有本阶段非浏览器测试合计 47 通过、1 个无环境集成测试跳过。
- 临时 MySQL 8.0.46、`REPEATABLE-READ`、两条独立连接实测：两笔 `60 + 60 > 100` 中一笔成功、一笔锁后重读并拒绝，最终账本为 60；测试容器已删除。
- 构建边界测试：2/2 通过。
- `pnpm build:aliyun`：通过编译、TypeScript、页面数据收集及 36 个页面/路由生成。
- `pnpm exec tsc --noEmit`：通过。
- 本地 `http://127.0.0.1:3000` 浏览器/API 回归测试：4/4 通过。
- `pnpm lint`：失败，28 个存量错误；未发现本轮服务端与新增测试的定向 ESLint 错误。

## Final Audit

- 已核对当前 diff、提交历史、测试结果和独立 reviewer 结论；本文不再包含待填占位内容。
- 本阶段关闭的是明确列出的安全与一致性缺陷，不代表完整前后端分离已经完成，也不代表已经达到生产上线门禁。
