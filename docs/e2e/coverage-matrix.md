# 角色×模块×页面×场景 覆盖矩阵（单一来源）

本矩阵说明当前 Scope A / Stage 12 的页面、角色、业务场景及自动化/人工检查边界。sliceId 只是稳定的覆盖项编号，不规定测试工具和执行方式。

## 状态图例

| 标记 | 含义 |
| --- | --- |
| implemented | 当前实现及受控测试基础足以执行 |
| demo-shell | 演示/空壳，只做可见性观察，不判通过 |
| out-of-scope | 明确超范围，不执行也不判通过 |
| no-fence-profile | 功能已实现，但当前自动化无冻结写入 profile；转人工检查或记录 NOT_RUN |
| missing-fixture-role | 缺 fixture 角色；需环境管理员授权，否则 HUMAN_CHECKPOINT/BLOCKED |

## slice × 角色 × fence × 状态

| sliceId | 页面 | 主要验收角色 | 补充检查角色 | 自动化 fence profile | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1-IDENTITY | 登录 | admin | supply_chain, finance, denied | foundation-auth-worker | implemented |
| A1-VISIBILITY | 工作台可见性 | admin | supply_chain, finance, factory, denied | foundation-auth-worker | implemented（职责分离最终角色组合待业务裁决） |
| A2-APPR | 审批中心 | admin | supply_chain, finance, denied | （无） | no-fence-profile |
| R2-1-MASTER | 物料与补料 | supply_chain | factory, denied | t2-supply-master-data | implemented |
| R2-1-SUP | 供应商管理（核心） | supply_chain | factory, denied | t2-supply-suppliers | implemented |
| R2-1-SUP-PRICE | 供应商价格 | supply_chain | factory, denied | （无） | no-fence-profile |
| R2-1-SUP-PERF | 供应商绩效 | supply_chain | company_qc, denied | （无） | no-fence-profile |
| R2-1-PROC-PLAN | 采购计划 | supply_chain | factory, denied | t2-supply-purchase-plan | implemented |
| R2-1-PROC-ORDER | 采购单 | supply_chain | factory, denied | t2-supply-purchase-order | implemented |
| R2-2-PROC-IMPORT | 导入 preview/stage/commit | supply_chain | denied | （无） | no-fence-profile |
| R3-1-INV | 库存管理 | supply_chain | factory, finance, denied | t2-operations-inventory | implemented（warehouse 写见下） |
| R3-2-PROD | 执行单 | factory | supply_chain, finance, denied | t2-operations-production-quality | implemented |
| R3-2-QC | 生产质检 | admin | supplier_qc, denied | t2-operations-production-quality | implemented（company_qc 由 admin 判定） |
| R3-3-SHIP | 发货管理 | supply_chain | factory, receiver, denied | t2-operations-logistics | implemented（receiver lane 缺 fixture → missing-fixture-role） |
| R3-4-FIN | 财务结算 | finance | supply_chain, denied | t2-operations-finance | implemented（禁止真实支付） |
| P1-PLAT | 跨页面 | platform | 被重放命令的角色 | 随命令对应 profile | implemented |
| P2-PLAT | Worker | platform | — | foundation-auth-worker | implemented |
| C1-PLAT | 旧 GET 退役 | platform | — | 任意已 start 的 run | implemented |
| C2-PLAT | OSS 缺失 health | platform | — | 需受控 aliyun-runtime | implemented（非 preview 可替代） |
| S12-A-PROC | 采购管理 | supply_chain | factory, denied | t2-operations-scope-a-closures | implemented（J01 lane） |
| S12-B-QC | 生产质检 | admin | supplier_qc, denied | t2-operations-scope-a-closures | implemented（J02 lane） |
| S12-C1-PROD | 执行单 | factory | supply_chain, denied | t2-operations-scope-a-closures | implemented（独立 RUN_ID） |
| S12-C2-PROD | 执行单 | factory | supply_chain, denied | t2-operations-scope-a-closures | implemented（独立 RUN_ID，不先 release） |
| SYS-1-SYS | 系统管理 | admin | denied | （无） | no-fence-profile |
| DASH-VISIBILITY | 工作台/工厂协同/AI助手 | admin | — | — | demo-shell |

## 当前不自动执行（no-fence-profile）

- A2-APPR（MOD-APPR）、SYS-1-SYS（MOD-SYS）。
- R2-1-SUP-PRICE、R2-1-SUP-PERF（supplier price/performance）。
- R2-2-PROC-IMPORT（imports）。
- warehouse 写命令（r3.warehouses.commands）无冻结 profile，不属于 MOD-INV 当前自动化范围。

上述条目不能因为其他测试通过而误报 PASS；可在人工 UAT 中检查，未执行时如实记录 `NOT_RUN`。

## 三条业务闭环与旅程

| sliceId | 旅程 | RUN_ID 约束 |
| --- | --- | --- |
| S12-A-PROC | J01 | 与 S12-B 复用同一 RUN_ID 时先执行 |
| S12-B-QC | J02 | 复用同一 RUN_ID 时串行承接 S12-A |
| S12-C1-PROD | J03 | 独立 RUN_ID |
| S12-C2-PROD | J03 | 独立 RUN_ID，不先 release |

## 明确超范围（out-of-scope，不执行不判通过）

- 部分收货、超短收、冲销、供应商退货。
- MRP、多批次分配、替代/补退料、排产。
- 拆批、部分放行、复检、让步、返工报废、成本责任。
- 完整 MES/ERP、税务、银行、实时物流。
- 工厂协同大屏、生产级 AI、真实 provider、生产部署与生产凭据。

## 规则

- 声称“已通过”必须能定位到具体覆盖项、操作者角色和证据；自动化 profile 只描述当前测试能力，不是产品功能状态。
- `no-fence-profile` 表示当前不自动执行，不等于产品未实现或业务失败。
- demo-shell 与 out-of-scope 永远不进入 PASS；missing-fixture-role 不进入 PASS 直到角色授权补齐。
