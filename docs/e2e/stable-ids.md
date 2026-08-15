# 稳定 ID 约定

本文件统一角色、模块、业务旅程、场景和覆盖项标识，避免文档与证据使用不同名称。具体执行工具、浏览器和并发策略不在本注册表中。

## 角色

| 稳定 key | 中文 | 当前 fixture 是否生成 | 预验收可用性 |
| --- | --- | --- | --- |
| admin | 系统管理员 | 是 | 可用 |
| supply_chain | 供应链 | 是 | 可用 |
| factory | 组装工厂（绑定 factory） | 是 | 可用 |
| approver | 供应链审批人（role=supply_chain） | 是 | 可用 |
| finance | 财务（绑定 factory） | 是 | 可用 |
| denied | 供应商（非 supplier_qc，负路径） | 是 | 可用（denied probe） |
| company_qc | 公司质检 | 否 | 缺账号：只能 HUMAN_CHECKPOINT/BLOCKED |
| supplier_qc | 供应商质检 | 否 | 缺账号：只能 HUMAN_CHECKPOINT/BLOCKED |
| receiver | 收货方 | 否 | 缺账号：只能 HUMAN_CHECKPOINT/BLOCKED |
| platform | 环境管理员（非业务账号） | 是（环境侧） | 平台不变量；不做业务写 |

角色值：`admin`、`supply_chain`、`factory`、`approver`、`finance`、`denied`、`company_qc`、`supplier_qc`、`receiver`、`platform`。`platform` 不是应用内业务角色；缺 fixture 的业务角色不得伪造，只能记 `HUMAN_CHECKPOINT` 或 `BLOCKED`。

## 模块

| 稳定 ID | 中文 | 页面（导航） | 状态 |
| --- | --- | --- | --- |
| MOD-IDENTITY | 登录/OTP/Step-up/会话/角色可见性 | 登录、工作台可见性 | 已实现 |
| MOD-DASHBOARD | 演示看板 | 工作台静态看板、工厂协同、AI助手 | 演示/空壳，不判通过 |
| MOD-PROC | 采购（计划/订单/整批收货/导入） | 采购管理 | 已实现（imports 无 profile） |
| MOD-SUP | 供应商（核心/价格/绩效） | 供应商管理 | 已实现（price/performance 无 profile） |
| MOD-MASTER | 主数据（SKU/BOM） | 物料与补料 | 已实现 |
| MOD-PROD | 生产 | 执行单 | 已实现 |
| MOD-QC | 质检 | 生产质检 | 已实现 |
| MOD-INV | 库存/调拨/盘点 | 库存管理 | 已实现（warehouse 写无 profile） |
| MOD-SHIP | 发货/收货/退货 | 发货管理 | 已实现（receiver 无 fixture） |
| MOD-FIN | 财务 | 财务结算 | 已实现（禁止真实支付） |
| MOD-APPR | 审批 | 审批中心 | 已实现（无 profile） |
| MOD-SYS | 系统管理 | 系统管理 | 已实现（无 profile） |
| MOD-PLAT | 平台不变量 | 跨页面（幂等/fence/unknown/audit/outbox/退役/health） | 已实现 |

## 旅程

| 稳定 ID | 关联闭环 | 链路 |
| --- | --- | --- |
| J01 | S12-A | 采购单 → 整批收货 → 待检批次 |
| J02 | S12-B | 待检批次 → 整批质检 → 放行/隔离 |
| J03 | S12-C | 生产预留 → 领料/消耗 → 释放（C1）或完工（C2） |
| J-AB | S12-A→S12-B | J01 与 J02 使用同一 RUN_ID 串行衔接 |

## 场景组（parentCaseId）

parentCaseId 用于聚合相关检查；最终结果落在下面的具体覆盖项。

| parentCaseId | 含义 |
| --- | --- |
| A1 | 登录、OTP、Step-up、角色/组织范围 |
| A2 | 审批批准、拒绝、重放 |
| R2-1 | 主数据、供应商、采购计划/订单（供应侧聚合） |
| R2-2 | 导入 preview-stage-commit |
| R3-1 | 库存、调拨、盘点 |
| R3-2 | 生产与质检 |
| R3-3 | 发货、收货、退货 |
| R3-4 | 财务 |
| P1 | 幂等、digest、fence、unknown outcome |
| P2 | audit、Outbox、Worker retry/重复投递 |
| C1 | 18 个旧 GET 退役 |
| C2 | OSS 缺失时 Web health |
| S12-A | 采购单→整批收货→待检批次 |
| S12-B | 待检批次→整批质检→放行/隔离 |
| S12-C1 | 生产预留→领料/消耗→释放 |
| S12-C2 | 生产预留→领料/消耗→完工 |
| SYS-1 | 系统管理（用户/角色/解锁/审计） |

## 覆盖项（sliceId）

sliceId 命名为 `<parentCaseId>-<MODKEY>`，用于把聚合场景拆成可独立记录结果的覆盖项。

| sliceId | parentCaseId | module | 主要验收角色 | 补充检查角色 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1-IDENTITY | A1 | MOD-IDENTITY | admin | supply_chain, finance, denied | implemented |
| A1-VISIBILITY | A1 | MOD-IDENTITY | admin | supply_chain, finance, factory, denied | implemented |
| A2-APPR | A2 | MOD-APPR | admin | supply_chain, finance, denied | no-fence-profile |
| R2-1-MASTER | R2-1 | MOD-MASTER | supply_chain | factory, denied | implemented |
| R2-1-SUP | R2-1 | MOD-SUP | supply_chain | factory, denied | implemented |
| R2-1-SUP-PRICE | R2-1 | MOD-SUP | supply_chain | factory, denied | no-fence-profile |
| R2-1-SUP-PERF | R2-1 | MOD-SUP | supply_chain | company_qc, denied | no-fence-profile |
| R2-1-PROC-PLAN | R2-1 | MOD-PROC | supply_chain | factory, denied | implemented |
| R2-1-PROC-ORDER | R2-1 | MOD-PROC | supply_chain | factory, denied | implemented |
| R2-2-PROC-IMPORT | R2-2 | MOD-PROC | supply_chain | denied | no-fence-profile |
| R3-1-INV | R3-1 | MOD-INV | supply_chain | factory, finance, denied | implemented |
| R3-2-PROD | R3-2 | MOD-PROD | factory | supply_chain, finance, denied | implemented |
| R3-2-QC | R3-2 | MOD-QC | admin | supplier_qc, denied | implemented（company_qc 由 admin 判定） |
| R3-3-SHIP | R3-3 | MOD-SHIP | supply_chain | factory, receiver, denied | implemented（receiver lane 缺 fixture → missing-fixture-role） |
| R3-4-FIN | R3-4 | MOD-FIN | finance | supply_chain, denied | implemented |
| P1-PLAT | P1 | MOD-PLAT | platform | 被重放命令的角色 | implemented |
| P2-PLAT | P2 | MOD-PLAT | platform | — | implemented |
| C1-PLAT | C1 | MOD-PLAT | platform | — | implemented |
| C2-PLAT | C2 | MOD-PLAT | platform | — | implemented（需受控 aliyun-runtime） |
| S12-A-PROC | S12-A | MOD-PROC | supply_chain | factory, denied | implemented（J01 lane） |
| S12-B-QC | S12-B | MOD-QC | admin | supplier_qc, denied | implemented（J02 lane） |
| S12-C1-PROD | S12-C1 | MOD-PROD | factory | supply_chain, denied | implemented |
| S12-C2-PROD | S12-C2 | MOD-PROD | factory | supply_chain, denied | implemented |
| SYS-1-SYS | SYS-1 | MOD-SYS | admin | denied | no-fence-profile |
| DASH-VISIBILITY | — | MOD-DASHBOARD | admin | — | demo-shell |

## 运行与问题标识

- `RUN_ID` 必须匹配 `^e2e-[a-z0-9][a-z0-9-]{5,80}$`，用于隔离测试数据、环境和证据目录。
- 问题 ID 使用 `ISS-<RUN_ID>-NNN`，其中 NNN 为三位序号。
