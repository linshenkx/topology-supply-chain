# 009 · 独立 Fastify API runtime

## 提交元数据与父链

- 提交：`8f57eac4fba820c221e6ecbfce6ff0f4dee4e8e6`（`feat: establish independent api runtime`）
- 父提交：`7c854572f1619695fec38bdb63e5e26b85ddc589`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T08:27:27+08:00`
- 命令证据：`git show --stat 8f57eac`；最终对照：`git log -p 8f57eac..fa2581c -- apps/api/src/app.ts apps/api/src/server.ts apps/api/package.json`

## 声明目标

建立可独立构建、启动、测试和关闭的 Fastify 进程与共享契约包；先交付 health、错误、requestId、OpenAPI 和安全日志，不迁移复杂业务写入（`docs/refactor/stage2-api-implementation-notes.md:5-18`）。

## 实际改动和 diff 规模

18 文件，`1651 insertions / 22 deletions`：API 源码 625 行（其中安全日志 285）、API 测试 440 行、contracts 93 行、workspace/包配置及 lockfile。新增直接依赖 Fastify 5.11.3、`@fastify/swagger`，dev 增 `tsx`。

## 对应 docs/refactor 依据

路线图阶段 2 要独立 API/Worker、runtime schema/OpenAPI/错误/requestId/日志/health（`docs/refactor/03-migration-roadmap.md:149-180`）；目标架构明确新 API 为 Fastify 模块化单体（`docs/refactor/02-target-architecture.md:13-17`）。单提交只完成 API runtime，笔记明确未完成认证、DB、Worker/fence，未用文档冒充完成。

## 必要性与 Scope 分类

独立 API runtime 是前后端进程/契约边界的 Scope A 核心增量。Purchase Receipt、BOM、质检等 Scope B 未实现是正确边界，不构成本提交失败。

## 复杂度增量

- 文件/代码：+18 文件、净 +1629 行；约 27% 是 API 测试，lockfile +358 净行。
- 依赖：Fastify、Swagger、tsx；新增 `apps/api` 与 `packages/contracts` 两个 workspace 包。
- 运行组件：新增可监听 3001 的 API 进程，但本提交尚未改 Nginx/部署，旧 Next API 仍是唯一业务栈。
- 概念：双 runtime、共享契约、OpenAPI、readiness checks、统一 error envelope、安全日志控制器、优雅关闭。

## 正确性、安全、权限、事务、兼容

health Schema 与 OpenAPI 同源；404/500 不泄露 route/exception；请求日志剥离 query，Cookie/auth/set-cookie 强制 redact；SIGTERM/SIGINT 有幂等关闭。尚无身份、权限、数据库或事务代码，因此这些能力既未破坏也未完成。旧 Next 完全不动，兼容风险低；双栈是 Strangler 必然的暂态成本。

## 业务语义是否改变

没有业务接口或前端调用变化；仅新增空载 runtime 和 health/error 契约。

## 测试与证据质量

12 个 Fastify inject 测试覆盖 live/ready 成败/超时、requestId、404/500、OpenAPI、安全日志和恶意 logger override。阶段笔记还记录 API/contract build、全仓回归、镜像只读/非 root 运行和本地两个进程 200；证据质量强。readiness 当时无注册依赖，返回 200 只表示空载 runtime ready，文档对此表述诚实。

## 当时问题

- **Important — 安全日志实现相对业务价值过重，并深度耦合 Fastify 内部生命周期。** `8f57eac:apps/api/src/safe-logging.ts:1-285` 为只有两个 health route 的 runtime 自定义 `LogController`，覆写 incoming/completed/defaultError/stream/writeHead/serializer/serviceUnavailable 等方法；该文件比 `app.ts` 还大。它确实防止 logger override 绕过脱敏，但维护面和框架升级风险高，宜优先尝试“固定不可覆盖的 logger factory + 标准 serializers/redact + 少量 hook”，只为无法覆盖的漏洞保留定制代码。

## 后续修复链

`988416f` 才将 `/api/v1` 路由到独立服务并补镜像/协同发布；`6b0d6ce` 接 MySQL、Session 和首个真实读接口；`b86d9a5` 加写平台/Worker；之后逐域迁移。`safe-logging.ts` 最终仍约 6.5 KiB，核心自定义控制器保留，未明显简化。

## 最终状态

Fastify runtime 成为最终 Scope A canonical API，并在生产启动时装载读写 manifest（`apps/api/src/server.ts:9,56-58`）。迁移期双栈通过旧写入口 410、writer fence 和 v1 路由逐步收口；初始 runtime 的必要性得到验证。日志控制器仍是保留的过度设计候选，不是已证明的当前功能缺陷。

## 结论与置信度

- 标签：**方向正确但实现偏重**
- 置信度：高。
