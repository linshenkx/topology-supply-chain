# 006 · 阿里云生产构建边界

## 提交元数据与父链

- 提交：`23c4572d2a0662f94f575674db0b86a35453d137`（`build: enforce aliyun production boundary`）
- 父提交：`3533a769bde67c342efe5d89f5aee217c3814f5d`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T04:03:52+08:00`
- 命令证据：`git show 23c4572`；最终对照：`git log -p 23c4572..fa2581c -- Dockerfile.aliyun package.json scripts/build-aliyun.mjs`

## 声明目标

让 Windows/Linux 和 Docker 的阿里云构建一致地固定 production/aliyun 标记，并排除不属于源码事实源的 `outputs/**` 归档副本。

## 实际改动和 diff 规模

7 文件，`100 insertions / 6 deletions`：33 行跨平台构建脚本、47 行测试、Docker 环境 +3、package/tsconfig/eslint 小改及笔记更新。

## 对应 docs/refactor 依据

路线图要求统一 Windows/Linux 开发/构建行为（`docs/refactor/03-migration-roadmap.md:166`），身份修复又依赖生产环境标记 fail closed。

## 必要性与 Scope 分类

这是 Scope A 的构建与安全配置修复；与 Scope B 无关。

## 复杂度增量

新增一个 33 行 Node wrapper 取代 POSIX 前缀或调用者手工设置环境；无新生产依赖或进程。脚本是跨平台约束的适度成本。

## 正确性、安全、权限、事务、兼容

builder/runner 与脚本统一 `NODE_ENV=production`、`APP_ENV=production`、`DEPLOY_TARGET=aliyun`，补强第 02 提交的预览边界。`outputs/**` 是归档副本，排除可避免重复/缺依赖代码污染 typecheck；不会放宽实际应用源码检查。

## 业务语义是否改变

无业务语义变化；生产构建的环境分支更确定。

## 测试与证据质量

2 个测试核对 ignore 和环境覆盖；阶段笔记还记录 `pnpm build:aliyun` 完整通过。测试没有构建镜像，但实际 Next build 证据弥补了纯配置断言局限。

## 当时问题

未发现提交目标内 Critical/Important/Minor 问题。将整个 `outputs/**` 排除的边界需持续保证该目录只存归档；本基线中的实际源码不依赖它。

## 后续修复链

`616c942` 为本地 vendor xlsx 包补 Docker COPY；`fa2581c` 升级 Next 并移除临时代理依赖。`scripts/build-aliyun.mjs` 的核心逻辑最终未改变。

## 最终状态

修复完整保留且被 Web 构建继续使用。它也使第 02 提交在阿里云 runtime 的 fail-closed 条件稳定成立。

## 结论与置信度

- 标签：**必要且克制**
- 置信度：高。
