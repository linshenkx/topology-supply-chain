# Stage 3 Authenticated Read Migration Implementation Notes

## Source

- 用户要求继续利用独立会话/子代理并发完成后续重构阶段。
- 基线：`codex/refactor-stage2-api@988416f`；实施分支：`codex/refactor-stage3-auth-read`。
- 本切片目标：为独立 Fastify API 建立 MySQL 运行边界、Session Cookie 身份上下文，并迁移首个真实低风险只读业务接口。

## Design Decisions

- 独立 API 不复用带 D1 强转的旧 `db/index.ts`，也不复制 82 张 Drizzle 表；本切片用 `mysql2/promise` 封装最小、参数化的 `QueryExecutor`，后续领域仓储逐步建立明确查询边界。
- 沿用现有 `topology_session` Cookie 和 SHA-256 token hash，使旧 Next 登录产生的会话可被 Fastify 验证；API 不接受代理身份头。
- Session Cookie 总是先于本地预览验证；本地预览只允许“所有生产标记均关闭 + hostname、Fastify request IP、原始 socket remote address 均为 loopback”的无 Cookie 请求。生产缺数据库配置直接启动失败，非预览请求缺数据库时返回脱敏 503。
- 数据库 query/execute 使用同一墙钟期限覆盖连接池排队和 SQL 执行；排队超时后释放迟到连接，执行中超时或协议超时销毁连接。非幂等 execute 超时明确视为结果未知，禁止自动重试。
- 第一个业务迁移选择 Master Data GET（SKU/BOM/换算/组件），因为它是无 PII 的真实业务读链；POST 仍留在旧 `/api/master-data`，避免同时迁移审批写路径。
- Web 的 Master Data GET 改为 `/api/v1/master-data`；本地 3000 使用固定目标、仅 GET、非生产受限的开发代理到 3001，阿里云生产由 Nginx 直接转发。
- Master Data 暂定权限矩阵：`admin/supply_chain/company_qc` 读取完整主数据；带有效 `factoryId` 的 `factory` 仅读取 active SKU 和 approved+active BOM；`finance/supplier_qc/receiver/unknown` 先拒绝并且不访问数据库，待业务 UAT 决定是否开放更窄视图。
- SKU/BOM 先选定稳定排序的父集合，再按父 ID 参数化读取换算与组件；子集合超过当前硬上限时返回脱敏 503，禁止以不闭合的 200 响应误导 BOM 对比。
- API 容器只新增 MySQL URL、连接池、TLS 和超时配置，不重新继承整份 `.env.production`。

## Deviations

- 认证读取不再像旧 Next 路径那样把过期角色状态写回 `expired`；授权查询只采纳当前有效角色，清理状态留给后续后台任务，避免每次读请求产生角色维护副作用。
- 外部角色的换算和 BOM 组件会随可见 SKU/BOM 一并收窄；这比旧 GET 返回全部子记录更严格，是有意的数据最小化。
- 旧 GET 把 `finance` 视为内部账号并允许读取完整主数据；新 API 暂时拒绝该角色。这是保守授权偏差，不代表业务权限已经最终签字。

## Tradeoffs

- Session `last_seen_at` 仍是认证安全心跳写入；条件更新失败会复核会话，避免同毫秒并发误判，同时让并发撤销优先。
- mysql2 没有原生取消连接池排队；API 通过自身墙钟 deadline 先结束调用，并给迟到的连接挂载释放处理。SQL 已开始后只能销毁连接，因此 execute 超时不能据此判断数据库是否提交。
- 本切片只迁移 Master Data 的读路径，形成单一读所有者；写路径仍由 Next 持有，尚未涉及 writer fence。
- 当前 Master Data 返回父集合 500、换算 1000、组件 2000 的有界快照；溢出会失败关闭而不是分页，生产大数据量前仍需设计游标分页。

## Open Questions

- 需要业务 UAT 签字：财务是否读取 SKU 摘要、工厂是否应看到完整全局 BOM、供应商质检/收货方是否只需要关联单据中的物料快照，以及被拒角色的导航是否直接隐藏。
- 前端 Session Gate 本阶段仍使用旧 `/api/session`；`/api/v1/session` 已具备契约和服务端能力，但不与首个业务读迁移同时切换。
- 生产 RDS 上仍需用真实数据复核角色有效期、`DATETIME`/`+08:00` 语义、查询计划与索引；当前本地证据不替代阿里云 UAT。
- 下一批写迁移开始前必须先建立 writer fence、幂等键和 execute“结果未知”后的状态复核协议。

## Verification Notes

- 独立安全复核已用反例确认：有效本地 Cookie 不会被 preview 覆盖；畸形/未知 Cookie 不回退 preview；远端地址伪造 localhost 得到 401；账号在初查后被锁定得到 403；Session/Master Data 成功与失败响应均为 `private, no-store`。
- 永不返回的连接/SQL 已验证在约 40ms 的测试 deadline 下返回脱敏错误并销毁执行中连接，Auth 与 Master Data 请求不再无限挂起。
- Master Data 定向测试覆盖角色矩阵、500/1000 BOM 子集合闭合、稳定排序、空父集合、子集合溢出 503、开发代理 Cookie/身份头过滤和生产拒绝。
- 初次加载使用 `AbortController`，组件卸载时取消请求；GET 走 v1，POST 保持旧路径，非 2xx 与网络失败展示中文提示。
- 最终门禁：API 64/64；旧系统 62 通过、1 项需 `TEST_DATABASE_URL` 的 MySQL 集成按预期跳过；部署边界 11/11；全仓 TypeScript、变更范围 ESLint、`git diff --check`、Bash 语法和 Compose 模板插值均通过。
- `build:aliyun` 成功生成 37 个路由；API Docker 镜像构建成功，生产闭包约 21.9 MiB，UID 1001，不包含 Next.js 或旧应用目录。生产缺 `DATABASE_URL` 时启动失败关闭。
- 独立运行时复核使用 MySQL 8.0.46：TLS 协商为 `TLS_AES_256_GCM_SHA384`；严格 CA 拒绝自签证书且错误脱敏；query/execute 执行中超时约 159/161ms，旧连接被销毁，新连接可继续查询；readiness 200，SIGTERM 退出码 0。
- 本地联调最终状态：Web `127.0.0.1:3000`、API `127.0.0.1:3001`；direct Session preview、direct Master Data preview、3000 开发桥 Master Data 均为 200。旧 Stage 2 临时 API 容器已精确停止并移除。

## Final Audit

### Delivered

- 独立 Fastify API 已从只有健康检查扩展为具备生产 MySQL 边界、Session Cookie 身份上下文和首个真实业务读取模块。
- Master Data GET 的读取所有权已迁到 `/api/v1/master-data`；Next 写接口保持原位，回滚时只需把前端 GET 恢复到旧路径。
- API 部署、健康检查、同版本发布/回滚、最小环境变量和安全日志边界均进入自动化门禁。

### Independent review result

- 安全复核：PASS，P0/P1 为 0。
- 业务与授权复核：PASS，P0/P1 为 0；权限收紧与生命周期/分页语义需要 UAT。
- 运行时与真实 MySQL 复核：PASS，P0/P1 为 0。

### Accepted residual risks

- API graceful shutdown 尚无应用层硬期限；正常 SIGTERM 已验证，但极端卡死仍依赖容器停止宽限期强制终止（P2）。
- 角色在单个在途认证请求中的并发撤销不保证强即时；账号锁定、Session 撤销和过期已 fail closed。需要强即时角色撤销时应增加安全版本号或事务化快照。
- Master Data 仍是有界快照而非分页 API；数据超过子集合上限时选择 503，优先保证正确性。
- 本地开发桥无法从标准 Next `Request` 取得可信 socket 地址，只因固定 GET 且 preview 返回空数据而接受；禁止扩成通用代理或写代理。
- 正式 RDS 查询计划、业务角色矩阵、UTC/中国时区跨日和导航体验必须在阿里云 UAT 签字，不能由本地测试替代。

### Resource and release state

- 实施分支：`codex/refactor-stage3-auth-read`。
- 未推送、未部署生产、未执行 schema 迁移；真实 MySQL/Docker 临时验证资源均已清理。
- 本地 Web/API 进程保留供用户验收；运行日志位于被忽略的 `.tmp/`。
