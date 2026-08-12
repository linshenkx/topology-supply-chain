# 025 · `c3a04c3` 主数据与采购写迁移审查

## 提交元数据与父链

- 完整 SHA：`c3a04c3b0bc847851be0c739a761ad0970de1a99`
- 主题：`feat: migrate master data and procurement writers`
- 作者/时间：linshen，2026-08-12 06:03:48 +08:00
- 父提交：`b86d9a52529c9e155546c5c73d0a34d861b5521b`
- 后继链：`154f6f4` → `fa2581c`。

## 声明目标

迁移 R2 的 imports、主数据、供应商、价格/绩效、采购计划与采购单写路径；旧端点退役，前端切到 v1；为审批和 domain event 提供领域实现。

## 实际改动和 diff 规模

- 34 文件，`+3,717/-872`。
- 新模块约 2,586 行（approvals/command/imports/master-suppliers/procurement/shared），另有 757 行新测试/集成测试。
- R2 用 12 个 command-specific fence，优于后续 R3 的粗 Route fence。
- 旧 Next 写 route 大幅删除并改 410；前端使用 `r2-mutation-client`。

## 对应 `docs/refactor` 依据

- Stage 5 T2 与横切主数据/导入控制表。
- `03-migration-roadmap.md` Stage 4/5：供应商/SKU commit、采购计划/PO、不可变快照、旧 writer 退役。
- Scope A 不要求实现真实 Purchase Receipt 或库存入账。

## 必要性与 Scope 分类

迁移现有主数据与采购写路径属于 Scope A。Purchase Receipt 真实收货、来料质检和库存批次属于 Scope B，本提交未实现不判失败。

## 复杂度增量

- 新增 R2 专用 command executor，与平台通用 `executeCommand` 存在重复 canonical/idem/fence 逻辑；这是可简化候选。
- 新增一个 2,500+ 行聚合模块目录，仍按文件分领域但命名 `r2-master-procurement` 带迁移阶段色彩，长期维护不如稳定领域名清晰。
- 没有新运行组件；复用平台 Worker/Outbox。

## 正确性、安全、权限、事务、兼容

- command-specific fence、幂等、事务审计和 Outbox 均在 UoW 内。
- 采购创建验证计划分配、价格/供应商关系等服务端事实，减少客户端注入。
- 旧写端点 410 是明确兼容断点，但前端同步切换。
- 当时 import/source file 只校验 clean/category/宽泛内部角色，缺少 `import_upload + owner` 实体绑定；见问题。

## 业务语义是否改变

主数据与采购写所有者从 legacy 改为 Fastify；采购/供应商审批变为领域 handler。没有引入 Scope B 的收货/库存语义。

## 测试与证据质量

- 有 R2 单元、真实 MySQL 原子/审批 revision 集成测试文件；最终纯测试覆盖 manifest、CSRF/role/factory、幂等、附件绑定和 410。
- 本审查纯 API 230/230 通过；真实 MySQL R2 套件未因环境缺 URL而执行。

## 当时问题

- **Important — 导入证据文件允许内部用户引用另一内部用户的 clean import 文件。** 当时 `requireFile` 的 `scoped` 对 `admin/supply_chain` 直接为真，而 `stageImport/createPurchasePlan/createPurchaseOrder` 未传 `entity` 约束；命令级证据：`git show c3a04c3:apps/api/src/modules/r2-master-procurement/{imports.ts,procurement.ts,shared.ts}`。这会让知道 file ID/object key 的内部用户把他人上传件绑定到自己的导入/采购命令。

## 后续修复链

- **已由提交 27 修复。** 最终 `imports.ts:170-182`、`procurement.ts:105-119,347-361` 强制 `entityType='import_upload'` 且 `entityId=access.userId`；`shared.ts:302-330` 校验实体绑定，并有 `import evidence is bound to authenticated upload owner` 测试。
- 提交 27 还删除孤立 `writer-fences.sql`，纳入正式 `0004` 迁移 journal。

## 最终状态

附件越权缺陷已修；R2 核心迁移保留。残余问题是部署一次性激活、历史迁移和回滚检查，属于提交 27/平台集成根因。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**。
- 置信度：高。
