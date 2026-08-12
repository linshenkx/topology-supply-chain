# 提交 015：账号、审计、通知与文件读切片

## 提交元数据与父链

- SHA：`40b2038fab6d185a2ce808b31edece59bc1e23cd`
- 父提交：`40ea06bd29ea2871b0f812f53630282b86c0eeaf`
- 主题：`feat(api): migrate user audit notification and file reads`
- 提交时间：2026-08-11 16:55:09 +08:00。
- 父链：010 → … → 014 → 015；最终基线 `fa2581c`。

## 声明目标

迁移用户列表、审计日志/导出、通知列表和私有文件读取，为平台横切读能力建立契约和授权边界。

## 实际改动和 diff 规模

13 文件、2,825 行纯新增：4 模块 1,396 行、4 测试 1,009 行、4 契约 388 行、barrel 32 行。未在本提交接入 runtime/前端。

## 对应 docs/refactor 依据

- `02-target-architecture.md:257-289,339-354`：授权、文件私有化、观测。
- `04-production-gates.md:116-138,221-233`：权限矩阵和审计。
- `05-open-decisions.md:119-123,143-150`：文件驻留与保留仍待裁决。
- `stage4-read-migration-implementation-notes.md:29` 明确 production adapter 最小权限尚待复核。

## 必要性与 Scope 分类

属于 Scope A 的基础安全和平台读迁移。文件上传扫描状态机的完整业务写闭环不应在此 GET 切片验收。

## 复杂度增量

- 净增 2,825 行；无新依赖/运行组件。
- 概念：审计分页/导出、文件 entity scope、通知 actor ownership、用户角色投影。
- audit 模块 546 行和 files 320 行承载多格式/多授权路径；部分复杂度在 018 才有真实 adapter，导致切片接口与集成实现分离。

## 正确性、安全、权限、事务、兼容

- 通知按当前 actor 读取，用户/审计只允许内部角色；文件元数据结合 uploader/binding 和注入的 entity authorizer。
- 该提交的文件模块定义 `authorizeEntity?` 可选端口；实际最小权限取决于 018 runtime 注入。单看此提交不能证明文件 ACL 完整。
- 审计导出契约存在，但 XLSX/OSS 实现直到 018 才加入；当时模块测试依赖 fake port。
- GET 写审计会产生副作用；文件读取本身不在数据库事务中，适合只读，但 OSS 与元数据的时序错误需 fail closed。

## 业务语义是否改变

主要是边界迁移；通知可见性和文件访问比 legacy 更显式。用户列表包含组织绑定等字段，应只对管理权限开放。

## 测试与证据质量

测试覆盖角色拒绝、分页、导出端口、actor ownership、文件 key/内容类型与 entity authorization。切片级质量高；没有真实 OSS/IMDS、XLSX 安全和 runtime authorizer 证据，这些由 018 补齐。

## 当时问题

- Important：文件 ACL 的关键 entity authorizer 是可选注入端口，本提交本身没有 production wiring；若直接注册错误配置会退化为不完整授权。证据：`git show 40b2038:apps/api/src/modules/files/index.ts` 中 `authorizeEntity?:` 及注册逻辑；018 才在 runtime 注入 adapter。该问题在 018 集成时已关闭。
- Minor：审计/文件模块把格式导出、对象读取和业务授权集中在单文件，边界偏重；命令证据 `git show --numstat 40b2038`。

## 后续修复链

018 新增 `audit.ts`、`audit-xlsx.ts`、`oss-storage.ts`、safe XLSX 和 runtime wiring，补真实 adapter 测试并关闭上述 wiring 缺口。`616c942` 进一步替换高危 XLSX 依赖/关闭生产门禁。

## 最终状态

文件 entity authorizer 和安全基础设施已接入；该 Important 属“后续已修复”。模块集中度仍高，但功能边界有效。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**。
- 置信度：中高；production 具体业务 entity policy 仍依赖最终 adapter 覆盖面。
