# 项目内历史资产归档

此目录保留工程规范化前已经存在、用途不完全明确或仅用于历史交付/恢复的资产。生产运行、构建和 Docker context 均不得消费这里的内容。

- `manifests/assets.json` 是唯一的资产来源、目标、hash、大小、mtime、引用、敏感扫描与恢复证据清单。
- `legacy-deliveries/` 保存根目录历史发布 tar；`deliveries/` 保存原 `outputs/`；`working-notes/` 保存原 `.tmp/`；`diagrams/` 保存原 `work/`。
- 除 README 和 manifest 外，`archive/**` 默认保持 Git ignored；不得强制加入二进制或历史交付物。
- Manifest 只记录敏感扫描类别与次数，不记录匹配值；标为 `review` 的资产必须继续保持 ignored/protected，不能进入 Git 或 Docker context。
- 归档完成后运行 `node scripts/archive-assets.mjs restore-dry-run > restore-plan.json`：命令只读核对每个 target 的 SHA-256、bytes、mtime，拒绝任何已存在的原路径或不可恢复父路径，并输出 `copy-exclusive-preserve-mtime` JSON 恢复计划；它不创建、移动、删除或覆盖资产。审核计划后可运行 `node scripts/execute-archive-restore-plan.mjs restore-plan.json`；执行器在写入前重跑完整 preflight，只允许 exclusive copy，保留并复核 mtime/hash/bytes，永不移动、删除或覆盖已有路径。

任何新增归档都必须先提交 `planned` manifest，再执行调查、恢复 dry-run 和逐类移动。
