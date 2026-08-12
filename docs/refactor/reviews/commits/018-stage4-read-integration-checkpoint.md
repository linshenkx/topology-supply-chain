# 提交 018：Stage 4 读迁移集成 checkpoint

## 提交元数据与父链

- SHA：`1d04a3edd4fc4a329ed3e8d90f27ac60f33dbdb7`
- 父提交：`014ae8e29324393c323fc56748dfedb271aee116`
- 主题：`chore: checkpoint stage4 read integration`
- 提交时间：2026-08-11 19:28:21 +08:00。
- 父链：本段 010–017 的首次统一集成点；其后依次为 `226bfe1`、`79a833a`、`8475ef4` 三个授权修复，最终为 `fa2581c`。

## 声明目标

把各领域读切片注册到共享 runtime，切换活跃前端 GET，建立严格本地开发桥、共享读审计、OSS/XLSX adapter 和契约空值门禁，形成 Stage 4 checkpoint。

## 实际改动和 diff 规模

56 文件、2,747 行新增、628 行删除。新增 catch-all 开发桥、5 个基础设施文件、17 个前端小切换、runtime 142 行注册、11 组新/增补测试；同时对 production contracts/module 大幅删改。这是迁移实际生效点。

## 对应 docs/refactor 依据

- `00-overview.md:36-47`：源码/进程/契约/权限/发布边界。
- `02-target-architecture.md:219-289,339-363`：生成 Client、同域、安全文件与发布。
- `03-migration-roadmap.md:186-210,415-445`：Stage 3/4 出口和证据包。
- `04-production-gates.md:169-219`：契约、CI 和制品门禁。
- 本提交新增的 `stage4-read-migration-implementation-notes.md` 只写“final gates will be rerun”，没有给出最终 Stage 4 关闭证据。

## 必要性与 Scope 分类

属于 Scope A，且 runtime 注册、前端切换和部署兼容桥是让读迁移真正成立的必要集成。没有补 Scope B 实物业务闭环，不能据此判失败。

## 复杂度增量

- 净增 2,119 行，触及 56 文件。
- 新依赖/概念：OSS SDK adapter、IMDS 临时凭证、安全 XLSX 生成、共享 audit writer、catch-all 开发桥、路径 allowlist。
- 运行组件不新增，仍由 010 的 API 服务承载。
- 把横切基础设施和全部领域激活集中在一个 checkpoint，审查面过大；后续三连授权修复说明集成粒度削弱了质量信号。

## 正确性、安全、权限、事务、兼容

- 开发桥仅本地、仅 GET、精确路径 allowlist，生产拒绝；证据：`git show 1d04a3e:app/api/v1/[...path]/route.ts` 第 3-58 行及 `app/lib/v1-development-bridge.ts`。
- runtime 首次注册 finance、inventory、purchase、production、suppliers 等全部模块，并注入 database/audit/OSS adapter；此前切片并未对外生效。
- 前端只是把 URL 改为 `/api/v1`，仍手写 `fetch`/响应解析，没有生成 Client；不满足目标架构契约完成态。
- checkpoint 当时仍含 production option、supplier scope、returns scope 三项 Important，分别由紧随其后的三个 fix 修复；因此 checkpoint 不能真实代表质量门禁已关闭。
- shipments receiver 名称授权/scope-after-LIMIT 未被后续修复，最终仍存在。

## 业务语义是否改变

活跃 GET 消费者实际切到 v1；安全收紧可能改变外部角色看到的集合。写仍保留 legacy，因此没有改变写业务状态机。开发环境通过桥接保持同源 URL，生产直接由 Nginx 路由。

## 测试与证据质量

新增 contract nullability、开发桥、前端边界、OSS、audit/XLSX 等测试，覆盖面广。问题在于 `stage4-read-migration-implementation-notes.md:34-37` 只报告 focused tests 和“final gates will be rerun”，而 checkpoint 标题容易被误读成完成；三项随后修复是最强反证。真实门禁关闭应归于修复后 `616c942`，不是 018。

## 当时问题

- Important：checkpoint 集成了 016/017 的 production options、supplier scope、returns scope 缺陷；命令证据：`git log --reverse 1d04a3e..616c942` 的前三个提交均为授权修复。后续已修复，根因已在 016/017 分别计数。
- Important：receiver 仍按名称授权且在全局 LIMIT 后过滤。证据：最终与当时 `apps/api/src/modules/shipments/index.ts:150-188`；最终未修。
- Important：没有 OpenAPI 生成 Client，前端仍手写 fetch；证据：`git show 1d04a3e:app/components/*.tsx` 的 v1 URL 替换以及 `rg -n 'openapi-generator|orval|generate.*client'` 无命中。该根因已在 011 计数，最终未修。
- Minor：Stage 4 notes 的验证措辞是“currently passes”与“final gates will be rerun”，却没有在 checkpoint 文档中列出未通过/待修授权项；质量信号不充分。

## 后续修复链

- `226bfe1`：production options scope/DTO。
- `79a833a`：supplier role-bound scope、mixed roles、scope-before-LIMIT。
- `8475ef4`：returns role-bound SQL scope-before-LIMIT。
- `616c942`：在上述修复后关闭 Stage 4 生产门禁并处理依赖/XLSX；这才是合理的 Stage 4 gate close 点。

## 最终状态

三项已知授权缺陷均已修复；共享 runtime、开发桥和基础设施保留。receiver 名称授权/scope-after-limit、生成 Client 缺失仍在最终基线，故最终 Scope A 仍有读迁移残余风险。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**质量不足**、**后续已修复**。
- 置信度：高。
