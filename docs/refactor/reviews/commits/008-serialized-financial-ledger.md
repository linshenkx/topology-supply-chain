# 008 · 财务账本串行化

## 提交元数据与父链

- 提交：`7c854572f1619695fec38bdb63e5e26b85ddc589`（`fix: serialize financial ledger writes`）
- 父提交：`5fa8021973a04f6af54d6a3761a0d659d9c37a57`
- 作者/时间：`linshen <32978552+linshenkx@users.noreply.github.com>`，`2026-08-11T05:04:40+08:00`
- 命令证据：`git show --stat 7c85457`、`git diff 7c85457^ 7c85457 -- app/api/finance/route.ts app/api/approvals/route.ts`

## 声明目标

对付款、退款、补票/更正涉及的请款与异常行按稳定顺序加 MySQL `FOR UPDATE` 锁，在锁内重读账本、校验上限、写记录并重算状态。

## 实际改动和 diff 规模

9 文件，`1025 insertions / 89 deletions`。生产代码约 +490 净行，测试 +534 行；新增 138 行账本规则、111 行行锁 helper、一个 223 行 MySQL 集成测试。

## 对应 docs/refactor 依据

CONSISTENCY-001 明确要求付款不超额、唯一约束与原子条件共同兜底（`docs/refactor/04-production-gates.md:50-53`）；目标事务规则禁止事务外汇总后直接插入（`docs/refactor/02-target-architecture.md:301-307`）。

## 必要性与 Scope 分类

资金错账 P0 的 Scope A 止血，必要性高；没有扩展真实银行支付或 Scope B 实物业务。

## 复杂度增量

新增可支付账本分类/退款纠正规则、锁 ID 去重排序和跨旧路由复用。复杂度显著，但覆盖多个共享写者以避免死锁/漏锁。无新 npm 依赖或进程。

## 正确性、安全、权限、事务、兼容

锁序是“请款 ID 升序→异常 ID 升序”；锁内重读并对 net paid/exception remediation 做安全整数和上下界校验。真实写在非阿里云 MySQL fail closed，D1 只保留无副作用 preview，兼容选择保守。

## 业务语义是否改变

明确退款不计入已付余额，correction/reversal 是否计入由 `invoiceExceptionId` 分类；这属于对既有台账语义的纠正和显式化，而不是引入银行支付能力。

## 测试与证据质量

10 个规则/锁序测试，加 1 个真实 MySQL 8 双连接测试；阶段记录的 `60+60>100` 竞争只有一笔成功、最终 60。相比前几提交，证据质量最高。仍未有数据库唯一 bank reference，提交已明确不宣称生产 Ready。

## 当时问题

- **Minor — 为临时双方言单体引入了较重且部署名耦合的锁抽象。** `7c85457:db/row-lock.ts:47-78` 用 `isAliyunRuntime()` 而非“真实 MySQL + 事务能力”判断可执行性，导致非阿里云 MySQL UAT/本地环境也必须伪装部署标记；111 行 helper 与旧 D1 兼容是过渡成本。它不破坏阿里云正确性，但提高测试/迁移认知负担。

## 后续修复链

`b86d9a5` 建 Fastify UoW/幂等/fence/事务审计；`154f6f4` 将财务和审批写迁到新平台。最终旧 helper 仅服务退役路径，新写者直接依赖明确 MySQL `QueryExecutor`，避免以部署名判断数据库能力。

## 最终状态

超额付款竞态修复被保留并迁入 Fastify；临时跨方言/部署耦合已不再是 canonical 写路径。早期 Step-up request binding 和审计原子性残余也由后续平台提交关闭，不能算最终缺陷。

## 结论与置信度

- 标签：**方向正确但实现偏重**、**后续已修复**
- 置信度：高。
