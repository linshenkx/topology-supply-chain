# GitHub 网页上传指南

## 推荐设置

1. 创建 **Private（私有）** 仓库。
2. 创建时不要勾选自动生成 README、`.gitignore` 或 License。
3. 在仓库首页选择 **Add file → Upload files**。

GitHub 网页不会解压 ZIP。ZIP 适合传给协作开发者或留档；网页上传请使用本次生成的 `github-upload-batches` 目录。

## 上传批次

按 `batch-01`、`batch-02` 的顺序操作：打开批次目录，全选里面的内容并拖到 GitHub 上传区域，然后提交该批次。批次保持了原项目的目录结构。

完成后确认仓库根目录能看到 `app`、`db`、`deploy`、`drizzle-mysql`、`package.json`、`README.md` 等文件。

## 邀请开发者

进入 **Settings → Collaborators** 添加协作开发者。建议保护主分支，要求通过 Pull Request、至少一人审核，并禁止直接强制推送。

## 首次拉取

开发者拉取仓库后，复制 `.env.example` 为 `.env.local`，自行填写测试环境配置。不要共享生产密码或生产附件。
