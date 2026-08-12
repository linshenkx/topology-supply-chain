# 023 · `616c942` Stage 4 生产门禁收口审查

## 提交元数据与父链

- 完整 SHA：`616c942b681053334b11a5338cb30d4ed699280c`
- 主题：`chore: close stage4 production gates`
- 作者/时间：linshen，2026-08-11 21:41:39 +08:00
- 父提交：`9faab6465baa244462409409f0b01c6875c8482c`
- 后继链：`b86d9a5` → `c3a04c3` → `154f6f4` → `fa2581c`。

## 声明目标

关闭 Stage 4 的依赖与生产适配门禁：移除 API 对脆弱 `xlsx 0.18.5` 的依赖、固定受控 SheetJS 包、加固 XLSX 导出和 OSS STS/IMDS 凭据刷新，并补容器依赖边界测试。

## 实际改动和 diff 规模

- 16 文件，`+515/-156`，另新增约 2.4 MB vendored tarball。
- 根依赖改为 `file:vendor/xlsx-0.20.3.tgz`，API 移除 `xlsx`；锁定 `fast-uri 3.1.5`。
- 自研安全 XLSX 写出器增加公式中和、case-insensitive sheet 名、防非法 Unicode/超长单元格。
- OSS 增加 IMDSv2 token 缓存、STS 刷新、请求合并和失败后可重试 client promise。

## 对应 `docs/refactor` 依据

- `04-production-gates.md` DEP-001：高危 XLSX 与请求进程解析必须关闭。
- `02-target-architecture.md` 第 10 节：文件隔离、魔数/扫描和资源限制。
- Stage 4 notes 的待办：生产文件/导出适配需最小权限并可审计。

## 必要性与 Scope 分类

属于 Scope A 的依赖/文件安全和生产运行加固。没有声称完成入站 Excel Worker 扫描全链；真正的文件状态机在提交 24/27 继续实现。

## 复杂度增量

- 新增 vendored 二进制依赖，供应链可重现性增强但仓库体积增加。
- OSS 凭据生命周期从一次获取升级为 token/credential provider 与刷新合并，运行概念增加但符合云实例长期运行需求。
- 自研 XLSX 只承担受控导出，避免把通用解析库带入 API 生产闭包。

## 正确性、安全、权限、事务、兼容

- 安全：公式注入、非法 XML、大小边界、依赖版本与 tarball SHA 都有测试。
- 运行正确性：STS 能刷新，失败 promise 不永久毒化 client 缓存。
- 事务/权限：不涉及业务事务；OSS 仍由后续文件实体 ACL 收口。
- 兼容：导出时以 `'` 中和公式是有意内容变换；大小超限从生成失败而非输出潜在危险文件。

## 业务语义是否改变

不改变业务状态；仅改变导出安全编码与 OSS 凭据生命周期。

## 测试与证据质量

- 新增 OSS 128 行、安全 XLSX 122 行测试，并在部署边界中校验 vendored 包摘要和镜像闭包。
- 本审查部署边界 15/15、API 纯测试 230/230 通过。
- 标准 pnpm 入口仍受初始基线遗留的 `allowBuilds` 占位配置阻断；不是本提交引入，但本提交的“门禁关闭”没有消除该复现障碍。

## 当时问题

未发现提交自身可证实的未修 Critical/Important/Minor。

## 后续修复链

提交 24 引入 quarantine/scan 文件状态机与 Worker；提交 27 为 import evidence 增加实体/所有者绑定。此提交的依赖与导出加固保留至最终态。

## 最终状态

依赖/导出/STS 修复仍有效；但 DEP-001 的完整入站文件处理闭环应以后续 Worker 与文件 ACL 一并评价，不能仅凭此提交宣布完全关闭。

## 结论与置信度

- 标签：**必要且克制**。
- 置信度：高。
