# 提交 010：独立 API 部署与路由边界

## 提交元数据与父链

- SHA：`988416fe98a9b53d8a6e19a7d4430bdd9358fadb`
- 父提交：`8f57eac4fba820c221e6ecbfce6ff0f4dee4e8e6`
- 主题：`deploy: route api v1 to standalone service`
- 作者/时间：linshen，2026-08-11 08:29:09 +08:00。
- 父链关系：本段首个提交；最终审查基线为 `fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`。

## 声明目标

把 `/api/v1/*` 路由到独立 Fastify 服务，建立 API 镜像、Compose 运行单元、Web/API 同版本发布与协同回滚，但不迁移业务写入。

## 实际改动和 diff 规模

`git show --shortstat 988416f` 为 9 个文件、581 行新增、36 行删除。核心是新增 `Dockerfile.api`，在 Compose 中增加只绑定 `127.0.0.1:3001` 的 API 服务，Nginx 增加精确 `/api/v1/` 上游，发布/回滚脚本同时管理 Web/API；294 行部署边界测试占新增量的一半。

## 对应 docs/refactor 依据

- `docs/refactor/00-overview.md:36-47`：进程、发布和同域边界。
- `docs/refactor/02-target-architecture.md:50-84,356-363`：Web/API 独立运行、健康与回滚。
- `docs/refactor/03-migration-roadmap.md:149-182`：Stage 2 新后端底座。
- `docs/refactor/04-production-gates.md:193-219`：制品和发布证据。
- `docs/refactor/stage2-api-implementation-notes.md` 是实施声明，不作为正确性证明。

## 必要性与 Scope 分类

属于 Scope A，且是前后端进程分离的必要前置。没有引入 PurchaseReceipt、BOM 实物消耗或质检放行等 Scope B 能力，也不应据此要求这些业务闭环。

## 复杂度增量

- 文件：9；代码：净增 545 行。
- 依赖：无新运行依赖。
- 概念：第二运行服务、独立镜像、双服务 release tag、双健康门禁。
- 运行组件：新增 `topology-scm-api` 容器和 Nginx 上游；这是目标架构要求的真实复杂度，不是纯包装。

## 正确性、安全、权限、事务、兼容

- API 只暴露 loopback，容器非 root、只读根文件系统、`cap_drop=ALL`；Nginx 在 v1 location 清除三项外部身份头。证据：`git show 988416f:Dockerfile.api` 第 24-45 行、`git show 988416f:deploy/aliyun/docker-compose.yml` 第 35-69 行、`git show 988416f:deploy/aliyun/nginx-scm.conf` 第 31-50 行。
- 发布先迁移再同时启动 Web/API，回滚只切镜像不倒迁 Schema；符合 expand/forward-fix 边界。证据：`git show 988416f:deploy/aliyun/deploy.sh` 第 34-45 行、`rollback.sh` 第 32-50 行。
- 此提交尚无业务事务或领域权限面；把它评价为“整个系统已分离/可生产”均会越过证据。

## 业务语义是否改变

未改变业务语义；仅新增 `/api/v1` 流量入口和部署生命周期。旧 `/api/*` 仍归 Next。

## 测试与证据质量

边界测试覆盖镜像闭包、loopback、Nginx 路由、身份头清理、部署顺序和回滚镜像检查，命令级证据为 `node --test tests/api-deployment-boundary.test.mjs`。缺口是未在真实服务器执行 `nginx -t`、reload 和 HTTPS 冒烟；实施 notes 也明确保留该项，因此测试质量高但不是生产验收。

## 当时问题

未发现 Critical/Important。

- Minor：部署脚本在 API 健康失败后只退出，未自动恢复上一镜像；这是可运维性缺口，不破坏 Scope A 的部署边界。证据：`git show 988416f:deploy/aliyun/deploy.sh` 第 37-45 行。

## 后续修复链

后续 011 增加数据库/会话运行配置；018 增加实际读模块注册和前端切换；`616c942` 补齐 Stage 4 生产门禁。未见针对上述 Minor 的自动回滚修复。

## 最终状态

最终 `fa2581c` 仍保留独立 API 镜像、loopback 暴露、Nginx v1 路由和协同发布/回滚，且扩展为完整 Scope A API。基础边界有效；自动回滚仍不是现有脚本能力。

## 结论与置信度

- 标签：**必要且克制**。
- 置信度：高。部署文件、测试和最终实现相互吻合。
