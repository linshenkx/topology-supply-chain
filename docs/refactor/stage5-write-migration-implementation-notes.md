# Stage 5 Write Migration Implementation Notes

## Source

- 用户委托：基于提交 `1d04a3e`，只读核验旧 Next 写链路、数据库 schema、Stage 1–4 文档与 Fastify 基础，产出可派发的 Stage 5 写迁移与业务 UAT 计划；只允许写本文与 `stage5-write-migration-plan.md`，最后创建本地 docs-only commit。

## Design Decisions

- 将“下一阶段”解释为：Stage 5 采购首先切写，同时把 Stage 6 实物闭环和 Stage 7 物流/财务排成同一条有依赖的迁移列车；开发准备可并行，生产 writer fence 激活必须按业务链串行。
- Fastify 当前 `DatabaseClient` 没有 transaction API，现有 schema/migration 也没有 writer fence、canonical 幂等和 Outbox，因此把共享写控制面设为所有业务写迁移的硬前置任务。
- 多工厂状态以工厂子聚合为事实源，计划/采购单 header 只做派生摘要；商业采购单以 buyer legal entity、supplier、currency 为边界，避免整单状态被首个工厂响应覆盖。
- Receipt 归 Procurement，但 Receipt→Quality→Inventory 在同一 MySQL 事务通过模块 application port 编排；生产、质检、库存作为不可拆的切写和 UAT 单元。
- 财务首期只登记外部已执行支付并维护不可变应付台账，不发起银行支付；未来银行直连必须新增独立 PaymentInstruction 状态机。

## Deviations

- 未沿用路线图中 Stage 5/6/7 各自完全串行开发的表面读法；为了可派发并行工作，把五个用户可见任务设计成共享 contract 冻结后可并行实现，但保留严格的业务切写顺序。
- 未把 30 个旧写 Route 文件（37 个 POST/PATCH/DELETE 方法）逐个复制为同构 Fastify Route；按 canonical command 拆分 action multiplexing，同时在计划表中逐端点保留当前表、副作用、权限、事务、幂等、并发、补偿、前端和 UAT 归属。

## Tradeoffs

- 选择模块化单体内同步事务编排核心账实，牺牲早期服务自治，换取 Receipt/库存/付款原子性和较低迁移复杂度；通知、邮件、扫描和投影仍通过 Outbox 异步。
- 允许质检数量级部分放行，但只在批次属性真正不同才拆 child lot，降低批次数爆炸并保留数量守恒。
- writer fence 采用用例级粒度而非 Route/领域粗粒度，控制面记录更多，但可避免同一旧 Route 内不同 action 被一起冒险切换。

## Open Questions

- T2 前需确认 factory、buyer legal entity、supplier/payee 的关系，以及商业 PO 是否允许跨工厂。
- T3 前需确认 Purchase Receipt、部分放行、让步接收和不合格最终去向是否接受推荐默认。
- T3–T5 前需确认 receiver/supplier_qc/supply_chain_lead 的正式组织与角色范围。
- T5 前需确认首期只登记外部支付、真实已支付交易 UAT 边界和银行流水唯一范围。

## Verification Notes

- 基线核实为 detached HEAD `1d04a3edd4fc4a329ed3e8d90f27ac60f33dbdb7`，初始工作树干净。
- 已只读核验 Stage 1–4 notes、目标架构/路线图/生产门禁/开放决策、全部旧 Next POST/PATCH/DELETE 路由、核心 schema/migrations、Fastify runtime/database/contracts 和活跃前端写调用。
- 端点覆盖检查确认 30 个旧写 Route 文件（37 个写方法）全部进入计划；92 处本地证据引用的文件存在且起始行有效。
- Markdown 表格结构检查覆盖 110 行表格，未发现列分隔异常；两份新增文档的 no-index whitespace diff check 通过；写入范围检查未发现 docs/refactor 两个 Stage 5 文件以外的变化。
- staged docs-only 范围审计与 `git diff --cached --check` 已通过；提交后复核确认相对 `1d04a3e` 仅新增两份 Stage 5 文档且工作树干净。不运行源码构建/业务测试，因为本任务没有源码改动，验证目标是文档证据、覆盖和差异完整性。
