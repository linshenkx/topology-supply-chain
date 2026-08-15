# 文档索引

README 是当前工程唯一入口；本索引只按证据属性路由材料，不把某次验收、实施记录或历史快照当成当前运行状态。功能代码锚点 254e3a0 的 Stage 12 业务闭环，本 docs 是其 docs-only 后代；实际 repositorySha 以执行时 git rev-parse HEAD 为准并等于 e2e:status.repositorySha。

## 当前规范与能力

| 文档 | 用途 |
| --- | --- |
| [仓库 README](../README.md) | 当前运行拓扑、工程边界、支持矩阵、脚本与部署入口。 |
| [Scope A E2E 与 UAT 手册](./e2e/README.md) | 自动化基线、受控环境、业务场景、证据要求与真人验收入口。 |
| [覆盖矩阵](./e2e/coverage-matrix.md) | 角色、模块、页面、场景及当前自动化/人工检查边界。 |
| [Stage 12 真人业务验收手册](./e2e/stage12-human-business-acceptance.md) | 三条闭环的逐页面真人浏览器/UAT 手册与签字。 |
| [UAT 签字模板](./e2e/templates/uat-signoff.md) | 可填写的结果与签字表。 |
| [基础业务能力—测试覆盖矩阵](./business-capability-test-matrix.md) | Stage 11 基线测试证据与缺口；Stage 12 三条闭环现状以业务闭环设计为准。 |
| [协作开发指南](../CONTRIBUTING.md) | 环境、门禁、兼容与安全审查规则。 |
| [安全说明](../SECURITY.md) | 凭据、漏洞披露和发布审批要求。 |

## 阶段验收

| 文档 | 状态与边界 |
| --- | --- |
| [Stage 12 业务闭环设计](./scope-a-business-closure-design.md) | 当前业务闭环阶段的设计与自动化验收证据；真人验收走 Scope A E2E 与 UAT 手册。 |
| [Stage 11 真人与 Agent 联合 E2E 最终验收](./refactor/stage11-t3-final-e2e-acceptance.md) | 历史时点证据（Stage 11 Scope A 受控本机技术验收 GO）；保留真人 UI/UAT、真实 provider 和部署检查点，不替代当前 Stage 12 状态。 |
| [Stage 11 Scope A 自动化 E2E 报告](./refactor/stage11-t2-scope-a-e2e-report.md) | 8 个 Scope A 场景与 Tier 1 foundation 的实际运行证据、边界和未覆盖项。 |
| [Stage 10 E2E 最终验收](./refactor/stage10-e2e-final-acceptance.md) | Stage 10 的文档与基础门禁验收；其 Tier 1 待办已由 Stage 11 部分实现，保留作时点证据。 |
| [Stage 9 物理分离最终验收](./refactor/stage9-physical-separation-final-acceptance.md) | 物理分离与质量安全阶段验收；保留作早期时点证据。 |
| [Stage 9 T3 工程规范化最终验收](./refactor/t3-engineering-normalization-final-acceptance.md) | Stage 9 内部验收材料，供追溯，不替代最终验收。 |
| [Stage 6 Scope A 验收](./refactor/stage6-scope-a-acceptance.md) | 早期阶段验收，保留其时点证据，不代表最新结果。 |

## 实施记录与计划

[重构总览](./refactor/00-overview.md) 与 [业务基线](./refactor/01-business-baseline.md) 记录重构期背景、范围、决策与阶段性判断。docs/refactor/ 下的 stage*-implementation-notes.md、编排计划、债务清单与 T1/T2 报告均为实施过程证据；其中的日期、候选 SHA、路径和待办不自动更新为当前事实。

## 逐提交审查

[总体审查](./refactor/reviews/00-overall-audit.md) 汇总审查结论；[commits/](./refactor/reviews/commits/) 按提交保存审查，[segments/](./refactor/reviews/segments/) 按阶段汇总。此类文档评述的是审查时的候选，不作为当前能力或当前安全状态的唯一依据。

## 历史快照与原始证据

[history/](./history/) 保存项目状态快照、GitHub 上传说明和旧示例。路径、命令、状态与未完成项均为冻结时点证据；只修正 Markdown 导航链接，不改写历史事实。[PROJECT_STATUS](./history/PROJECT_STATUS.md) 已明确标注为 2026-08-04 快照。

## 维护规则

- 新的当前入口、能力或门禁变更先更新 README，再更新本索引路由。
- 新验收报告应标明候选、日期、结论和范围；只有最新已接受报告可在“阶段验收”中标为当前。
- 历史文档遇到失效 Markdown 链接时可做最小导航修复，并标注为后加导航说明；原始路径文字、结论和时点不改写。
- 逐提交审查和实施记录保留 Git 路径与提交引用，以便通过 Git 历史追溯。
