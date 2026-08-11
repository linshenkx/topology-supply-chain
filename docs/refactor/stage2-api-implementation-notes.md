# Stage 2 API Separation Implementation Notes

## Source

- 用户已确认按 Fastify 模块化单体、同域 `/api/v1`、Strangler 方式推进前后端分离，并授权子代理直接开发。
- 基线：`codex/refactor-stage1@7c85457`；实施分支：`codex/refactor-stage2-api`。
- 本切片只建立独立 API 运行单元、契约包、健康/错误边界与部署路由，不迁移复杂业务写入。

## Design Decisions

- 现有 Next.js Web 和旧 `/api/*` 保持不动；新 Fastify API 独立监听 3001，由 Nginx 将 `/api/v1/*` 路由给它。
- API 先提供无外部依赖的 liveness 与可注入依赖检查的 readiness；任何业务模块迁移前先验证独立构建、启动、关闭和错误契约。
- JSON Schema 由 `packages/contracts` 持有，API 响应与 OpenAPI 后续从同一事实源扩展。
- 根仓库固定 `pnpm@11.9.0`，workspace 使用 injected packages 与 build 后同步；API 镜像通过非 legacy `pnpm deploy --prod` 只携带自身生产闭包。
- 生产进程支持结构化日志、请求 ID、统一错误响应和 SIGTERM/SIGINT 优雅关闭；请求日志只记录 pathname，原始查询串、异常 message/stack/cause 与响应头不会进入日志。
- readiness 每项检查默认最多等待 2 秒，可由应用构建参数调整；超时和异常均返回脱敏的 `failed`，不把依赖错误内容暴露给调用方。
- Web、API 与 migrator 使用同一 release tag 发布；应用迁移成功后再启动 Web/API，并分别执行有界健康检查。回滚只协同切换 Web/API 镜像，不自动回滚数据库 schema。
- 当前 API 只有健康接口，因此不继承 `.env.production` 或任何 secrets；业务模块迁移时按最小权限逐项增加配置。

## Deviations

- 不在本切片移动现有 `app/` 到 `apps/web/`，避免目录噪音掩盖运行边界变化。
- 不在本切片接入生产数据库或复制旧认证逻辑；首个业务读接口将在 API 骨架稳定后迁移。
- 原计划中的“基本结构化日志”在独立审查后收紧为不可由 logger overrides 绕开的安全日志边界；同时补入 readiness 超时、双服务发布/回滚和 API 密钥隔离，这些均是提交前发现的真实生产阻断。

## Tradeoffs

- readiness 初始只覆盖已注册检查；数据库检查会随 MySQL 类型边界与 IAM 会话迁移一并加入。
- 根仓库暂时同时包含旧单包 Next 应用和新增 workspace 包，这是 Strangler 过渡状态。
- readiness 的 Promise 超时能限制 HTTP 探针等待，但不能强制取消不支持取消的底层调用；后续数据库、OSS 检查必须接收并遵守 `AbortSignal`。
- 本地 `dev:api` 当前默认监听 `0.0.0.0`；生产容器只通过宿主机 loopback 发布。认证、限流或审计迁入 API 前必须明确 trusted proxy 与客户端 IP 解析策略。
- `tsx` 固定为 4.23.1，避免 pnpm 11 的 minimum-release-age 供应链策略拒绝刚发布的 4.23.12；不得以放宽安全策略替代版本冷静期。

## Open Questions

- 首个迁移读域在 API 骨架验收后，从 IAM 会话查询或低风险 Master Data 查询中选择。
- OpenAPI UI 是否生产暴露需在认证与网络策略落地时决定；当前只生成并测试 OpenAPI 文档对象，不开放 UI 路由。
- 首个业务接口迁移前需补：MySQL readiness、Session Cookie 共享/轮换策略、API 侧授权中间件、指标/Trace，以及旧 `/api/*` 写入口的服务端 writer fence。
- 真实服务器仍需在证书与 `/etc/nginx/proxy_params` 就绪后执行 `nginx -t`、reload 和 HTTPS `/api/v1/health/ready` 冒烟；本地不能替代该门禁。

## Verification Notes

- `CI=true corepack pnpm@11.9.0 install --frozen-lockfile --ignore-scripts`：通过，最终宿主 `node_modules` 由 pnpm 11.9.0 生成。
- API 编译与契约编译：通过；API 测试 12/12 通过，覆盖 live/ready、超时、请求 ID、统一错误、OpenAPI、查询串/异常/Cookie 日志脱敏及恶意 logger override。
- 部署边界测试 11/11 通过；`deploy.sh`、`rollback.sh` 的 `bash -n` 通过。
- 全仓 Node 回归测试共 63 项：62 通过、1 项真实 MySQL 集成测试因未设置 `TEST_DATABASE_URL` 按设计跳过；新增代理后同步把身份头回归测试从“固定两个 location”收紧为“每个实际 proxy location 均必须清除”。
- 根 TypeScript 检查、变更范围 ESLint（零 warning）与 `git diff --check`：通过。
- Compose 最终展开模型确认 API 只含 `APP_ENV、DEPLOY_TARGET、HOST、NODE_ENV、PORT`，无 `env_file`、无 secrets，且仅发布到 `127.0.0.1:3001`。
- `pnpm build:aliyun`：通过，Next 生产构建生成 36 个路由，说明 workspace/lock 变化未破坏现有 Web。
- 最终源码镜像：`sha256:6d5497dfc7404a69862c4403750fa93067edfe9a6ae9a6cbdcf4ea794e0eca67`，173,748,587 bytes；API 运行目录约 16.7 MiB，生产闭包 57 个包。
- 最终镜像运行态：live/ready 均为 200，404 保持入口 request ID，秘密查询串不进入日志；容器为 UID 1001、只读根文件系统、`cap_drop=ALL`、`no-new-privileges`。
- 本地 Web `http://127.0.0.1:3000/` 与独立 API `http://127.0.0.1:3001/api/v1/health/ready` 均返回 200。

## Final Audit

- 已完成：独立 Fastify 进程、共享契约包、`/api/v1` 同域代理、OpenAPI/错误/请求 ID/安全日志/有界健康检查、API 专用最小镜像、双服务发布与协同回滚边界。
- 未完成且不伪装为完成：认证、数据库和业务接口仍在旧 Next `/api/*`；数据库 readiness、Worker/Outbox、指标/Trace、writer fence、真实服务器 Nginx 验证仍待后续切片。
- 独立审查发现并推动关闭四类阻断：日志查询串与异常泄漏、logger override Cookie 绕过、readiness 无限等待、部署/回滚未管理 API 及无必要继承全部生产密钥。
- 本切片可提交为“独立 API 运行与部署边界”，不能据此声明整个系统已经前后端完全分离或达到生产 Ready。
- 实施记录中的验证均对应本工作区最终态，无剩余占位符。
