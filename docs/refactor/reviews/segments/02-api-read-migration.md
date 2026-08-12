# 段落 02：API 部署与读迁移（提交 010–018）

## 审查范围与方法

本段覆盖 9 个连续提交：`988416f`、`6b0d6ce`、`2f53f9b`、`285d269`、`40ea06b`、`40b2038`、`a2ea165`、`014ae8e`、`1d04a3e`。固定最终基线为 `fa2581c55cb6c688b77b2ed6f102a1fa86af09cd`。

每个结论同时核对提交自身 diff、父提交、后续修复链和最终实现。`docs/refactor` 仅作为待验证声明来源；Stage 4 notes 的 PASS/测试描述没有替代代码和修复链证据。Scope A 是独立 Web/API 边界、结构规范、基础安全与必要测试；PurchaseReceipt、BOM 实物预留/领料/消耗、质检放行/隔离属于 Scope B，本段没有因其未实现判 Scope A 失败。

## 提交统计与激活边界

| 项目 | 统计/判断 |
| --- | --- |
| 提交数 | 9 |
| 相对 010 父提交的累计 diff | 108 文件，23,843 additions，73 deletions |
| 主要文件构成 | API 源码 28、API 测试 29、contracts 20、前端 17、部署 7、docs 3、其他 4 |
| 运行边界 | 010 新增独立 API 容器/Nginx 路由；011 接入 MySQL/Session；018 才统一注册 012–017 模块并切前端 GET |
| 业务写边界 | 本段写入口仍属 legacy；不能把 v1 GET 迁移当成写迁移或业务闭环 |
| 后续直接修复 | `226bfe1` production options、`79a833a` supplier scopes、`8475ef4` returns scope；`616c942` 才关闭 Stage 4 生产门禁 |

012–017 应评价为“可集成读切片”，而不是独立可运行迁移。它们没有修改 `apps/api/src/runtime.ts` 或前端消费者；`git show <sha>:apps/api/src/runtime.ts | rg register...` 仅在 018 出现这些模块。这种先并行堆切片、后集中激活的组织方式提升了吞吐，但扩大了 checkpoint 的跨域审查面。

## 净复杂度趋势

净复杂度显著上升而非平移：23,843 行新增对应 73 行删除，legacy GET 在本段没有被删除。新增中约一半是测试和契约，说明并非纯粹复制；独立进程、MySQL deadline、Session、运行时 schema、scope-before-LIMIT、OSS/XLSX 安全适配也是真实必要复杂度。但以下部分明显复制了旧复杂度：

1. 每个模块重复定义 SQL column block、DataRow mapper、bounded limit、错误类、审计适配和 JSON Schema。
2. 生产 892 行、供应商 1,716 行等单文件把页面 option/排名/导出聚合整体搬到 API，而没有先抽出小型 Query repository/serializer。
3. contracts 只成为服务端 schema/interface；前端依旧手写 `fetch` 和响应解析，因而同时维护 schema、TypeScript 形状和 UI 假设。
4. legacy 与 v1 长期并存是 Strangler 的阶段性成本，但若没有新旧对账、生成 Client 和删除门禁，成本不会自动下降。

趋势判断：**运行和权限边界变好，代码净复杂度陡增；测试增量能覆盖大部分局部正确性，但未能在 018 前稳定住跨模块授权。**

## 授权数据范围

做得较好的部分：

- 011 的 Cookie 优先/preview fail closed、工厂主数据最小视图。
- 014 的工厂采购单只见自身 allocation，并重算可见数量/金额。
- 016 的 quality scope 在 SQL LIMIT 前过滤。
- 后续 `226bfe1`、`79a833a`、`8475ef4` 分别把 production option、supplier mixed roles/绩效、returns scope 修到 role-bound 且 scope-before-LIMIT。

最终仍存在的高信号缺口：

- **Important：receiver 用可变名称授权。** `apps/api/src/modules/shipments/index.ts:150-156,182-188` 以 `organizationName === destination` 判断；这与 `05-open-decisions.md:88-94` 推荐稳定 Receiver/DeliveryLocation ID 相冲突。
- **Important：receiver/factory shipment scope 在全局 LIMIT 后过滤。** 同文件 `169-188` 先取最近 200 条再内存过滤，合法数据可能被其他组织噪音挤出；也未做到最小数据库读取范围。
- **Important：财务/审批只有粗角色白名单，没有 legal entity scope。** `apps/api/src/modules/finance/index.ts:391-460` 与 approvals 同类代码不带组织参数；在 D-10 未裁决时只能视为单公司假设下的有限可用，不是目标权限模型完成。

## 契约、DTO 与兼容

共享 JSON Schema、Fastify response schema、nullability 测试和 fail-closed row mapper 是本段的强项。后续 production 修复还主动缩小 DTO，说明团队接受“最小必要字段”原则。

主要偏差是目标架构 `02-target-architecture.md:221-225` 要求 Schema 生成 OpenAPI 并生成前端 TypeScript Client；最终活跃页面仍直接 `fetch("/api/v1/...")`。命令 `rg -n 'openapi-generator|orval|generate.*client' package.json apps packages` 未发现生成器，而 `rg -n 'fetch\(' app/components app/page.tsx` 有大量手写消费者。因此：

- **Important：契约事实源只在服务端部分成立，前端没有生成 Client/drift check。** URL 切换成功不等于契约消费者兼容已自动验证。
- 固定上限/失败关闭保护了闭合 DTO，但多个列表无游标，在真实规模下会把容量问题表现为 503 或截断窗口；属于 Minor/容量 UAT 风险。
- 012 保留 `bankReference` 以兼容 UI，是有记录的敏感字段取舍，不应误称为完全字段最小化。

## 部署边界与兼容桥接

010 的部署边界总体扎实：API 只绑定 loopback，Nginx 同域路由，清除身份头，容器非 root/read-only，Web/API 同 release tag，发布/回滚分别检查两服务健康。这是 Scope A 最克制且高价值的提交。

018 的开发桥同样控制得当：`app/api/v1/[...path]/route.ts:3-58` 只有精确 GET allowlist，生产拒绝，超时有界，上游不可由请求指定。它是本地兼容工具，不是生产第二代理。应保留安全约束，并禁止扩展为通用写代理。

运行边界的残余风险是 deploy 健康失败只退出、不会自动恢复上一版本；这属于 Minor 运维缺口。Stage 4 读迁移本身未要求 writer fence，因为写仍在 legacy；不能错误地用“无 fence”判 GET 迁移失败。

## 测试与 checkpoint 真实性

测试量充足：29 个 API 测试文件/变更，覆盖会话反例、数据库超时、角色拒绝、DTO/空值、SQL scope、开发桥、OSS、审计和 XLSX。问题不是“没有测试”，而是 checkpoint 的跨域负向 oracle 不完整：

- 018 后第一个提交修 production options 授权。
- 第二个修 supplier role-bound/mixed-role/scope-before-LIMIT。
- 第三个修 returns role-bound SQL scope-before-LIMIT。
- `stage4-read-migration-implementation-notes.md:34-37` 当时只称 focused tests 通过且 final gates 将重跑，没有列出这些未发现项。

所以 018 是“集成 checkpoint”，不是“质量门禁关闭”。真实 gate-close 点应归到上述修复之后的 `616c942`。文档没有直接写 Stage 4 已生产 ready，但 checkpoint 名称和局部 PASS 证据容易误导；审查结论为“方向正确、质量信号不足、后续已修复”。

## 问题统计

以下按根因去重；同一问题在 018 再次显现不重复计数。

| 严重度 | 总数 | 后续已修 | 最终未修 | 根因摘要 |
| --- | ---: | ---: | ---: | --- |
| Critical | 0 | 0 | 0 | 未发现可证明的当前 Critical |
| Important | 9 | 5 | 4 | 已修：文件 production wiring、production options、returns scope、supplier role binding、supplier绩效 scope；未修：receiver 名称授权、shipment scope-after-LIMIT、财务/审批 legal scope、生成 Client |
| Minor | 9 | 0 | 9 | 自动回滚、固定上限/分页、一致快照、重复 mapper/query helper、单文件聚合、checkpoint 措辞等 |

“后续已修”只表示最终 `fa2581c` 不再含该缺陷；不把它们报告为当前缺陷。Scope B 的 PurchaseReceipt/BOM/质检库存闭环未计入问题总数。

## 与 docs/refactor 的偏差

1. **契约偏差**：实现了共享 schema/OpenAPI，但没有生成前端 Client，未完成规划中的契约消费者边界。
2. **授权偏差**：receiver 稳定 ID 和 legal entity scope 仍是开放决策，读实现却沿用名称/单公司假设；这是显式技术债，不应包装成目标权限模型完成。
3. **证据偏差**：规划要求新旧读对账、角色 UAT、可复现 evidence package；本段主要是单元/fake DB/局部真实 MySQL，缺生产数据范围签字与完整新旧差异报告。
4. **门禁偏差**：018 checkpoint 早于三项授权修复；Stage 4 close 只能归于后续 `616c942`。
5. **Scope 边界正确**：本段没有把 PurchaseReceipt、BOM 实物消耗或质检放行伪装成 GET 迁移成果；相关文档也基本把它们留在后续 Stage 5/6。

## 过度设计候选与建议

### 应保留

- 独立 API 进程/Nginx/镜像/健康和最小 secrets 边界。
- Cookie 认证 fail closed、数据库 deadline/unknown outcome 语义。
- scope-before-LIMIT、闭合 DTO、运行时 response schema、负向权限测试。
- 本地 GET 精确 allowlist 桥、共享审计 writer、私有 OSS/安全 XLSX 边界。

### 应简化

- 将重复的 row decoder、bounded query、placeholder、私有 no-store 响应和错误映射抽成少量共享 primitives，但不要抽象成通用 ORM/微服务框架。
- 把 1,716 行 suppliers 与 892 行 production 模块按内部 Query repository/serializer/option builder 拆分；保持同一 Fastify 模块和同一进程，不新增运行组件。
- 以现有 JSON Schema 生成 typed client，替换各组件手写 fetch/解析，并加 OpenAPI/client drift 门禁。
- 为列表采用游标/显式窗口契约；对需要一致视图的多查询读使用只读一致快照或明确标注 eventual consistency。
- receiver 建立稳定组织/地点 ID 后，把授权推入 SQL；财务/审批在 legal entity 模型确认后同样推进 scope。

### 不建议

- 不为每个领域拆独立微服务；本段的问题来自模块内重复和授权闭包，不是进程数量不足。
- 不用通用开发代理替代 018 的精确 allowlist。
- 不把 Scope B 业务补全塞回读迁移返工；应按联合实物波次独立验收。

## 段落结论

本段完成了真实的 Scope A 进展：独立 API 已可部署，Session/MySQL/契约/审计基础形成，大部分活跃 GET 已迁到 Fastify，若干 legacy 越权被修正。最强提交是 010；最需要简化的是 017；最不应被当成质量完成点的是 018。

整体标签：**方向正确但实现偏重**、**质量不足**、**后续已修复**。最终仍有 4 个 Important 读边界残余，尤其是 receiver 名称授权和生成 Client 缺失；在关闭这些项及完成真实角色/数据新旧对账前，不应宣称读迁移完全符合目标架构或生产权限门禁。

置信度：高。所有高信号结论均可由指定 SHA、后续修复序列和最终文件行号复现；业务组织模型尚未裁决的部分已明确标为假设风险。
