# 002 · 生产身份边界

## 提交元数据与父链

- 提交：`e6f527365f80c9b6ae68fbb7805e481cb0ceb71a`（`fix: harden production identity boundary`）
- 父提交：`2523b40956443080a206552bb15343d8f1a1eba1`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T03:13:01+08:00`
- 命令证据：`git show e6f5273`；最终对照：`git log -p e6f5273..fa2581c -- app/lib/authz.ts deploy/aliyun/nginx-scm.conf`

## 声明目标

关闭 SEC-001：不再把 `oai-authenticated-user-*` 当生产身份凭据，同时保留受限本地预览（`docs/refactor/04-production-gates.md:35-38`）。

## 实际改动和 diff 规模

5 文件，`156 insertions / 11 deletions`：新增 32 行 access boundary、修改 authz 21 行、Nginx +6、测试 +76、阶段笔记 +32。

## 对应 docs/refactor 依据

目标架构要求生产禁用 Header fallback、Nginx 清头、本地预览必须显式且只限回环（`docs/refactor/02-target-architecture.md:257-266`）；路线图把它列为第一项止血（`docs/refactor/03-migration-roadmap.md:124`）。

## 必要性与 Scope 分类

这是直接身份冒充 P0，属于 Scope A 必要安全修复，与 Scope B 无关。

## 复杂度增量

新增一个 32 行纯函数和 5 个小测试；无依赖、Schema 或新进程。应用与代理双层防御的复杂度与风险相称。

## 正确性、安全、权限、事务、兼容

生产身份统一为应用 Session；Nginx 两个当时存在的代理 location 均清三类头。远程预览会从 Header 自动登录变为 401，这是有意兼容破坏；正式前端原本已有账号登录。无事务/业务数据变化。

## 业务语义是否改变

仅改变认证入口语义：生产不再接受代理身份头；业务对象和状态机未变。

## 测试与证据质量

5 个 Node 测试覆盖三类生产标记、回环/非回环/坏 URL、authz 不读头、Nginx 清头。测试含源码模式断言，不能替代真实入口负测，但对本窄改动足够。

## 当时问题

- **Minor — 本地预览采用“未命中生产标记即允许”，不是显式 opt-in。** `e6f5273:app/lib/access-boundary.ts:18-29` 在三个环境标记均缺失/非生产时，仅凭 URL hostname 为 loopback 即返回 true；与门禁文字“显式环境开关”不完全一致。阿里云 Docker 父版本已有 `DEPLOY_TARGET=aliyun`，所以这不是该部署的可利用生产缺陷，但其他误配置运行方式仍是 fail-open 形态。

## 后续修复链

`23c4572` 在 build/runner 固定三类生产标记；`988416f` 新增 `/api/v1` location 时继续清头；Fastify IAM 后续不接受代理身份头，并将预览校验收紧到 hostname、Fastify IP、socket remote address 均回环。

## 最终状态

SEC-001 在最终基线关闭；Nginx 三个实际代理 location 均清头（`deploy/aliyun/nginx-scm.conf:45,57,69`）。旧 helper 仍保留隐式本地预览语义，但生产构建标记与新 API 边界使其不构成当前生产缺陷。

## 结论与置信度

- 标签：**必要且克制**
- 置信度：高。
