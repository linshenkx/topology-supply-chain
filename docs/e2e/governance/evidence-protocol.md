# E2E/UAT 最低证据与脱敏要求

每次运行使用唯一 `RUN_ID`，证据写入 Git 忽略目录 `delivery/agent-uat/<RUN_ID>/`。证据用于复核业务结论，不是独立交付目标；已有自动化证据可以引用，不要求在浏览器中重复生成。

## 最小目录

```text
delivery/agent-uat/<RUN_ID>/
├── evidence-manifest.json  # SHA、环境、场景结果、资源与清理状态
├── summary.md              # 本次结论、问题和未覆盖范围
├── issues.md               # 问题索引，可引用 issue 模板
├── http/                   # 脱敏请求/响应摘要
├── db/                     # 本 RUN_ID 的业务、audit、outbox 证据
├── ui/                     # 关键页面和状态变化截图
└── logs/                   # 脱敏日志尾部与退出码
```

没有内容的目录不必创建。每条关键业务链记录必要步骤、3–5 张代表性截图，并至少提供 HTTP、DB、audit、outbox 中一种可复核证据。

## 操作和截图

- 步骤记录页面、操作者角色、操作、预期、实际、时间和结果。
- 只对关键提交、状态变化、成功/失败反馈截图，不要求记录每次鼠标移动。
- 截图不得包含真实个人数据、凭据或密钥。
- 浏览器载体或测试环境失败时记录为 `BLOCKED`/`NOT_RUN`，不得据此判定产品功能 `FAIL`。

## API、DB、audit 与 outbox

- HTTP 保存方法、路径、脱敏 header 名、body SHA-256、状态和响应摘要；不得保存 Cookie、Authorization、CSRF、OTP 或完整 Set-Cookie。
- DB 只查询本 RUN_ID 关联的业务记录、`audit_logs` 和 `outbox_messages`，禁止跨 RUN_ID 或连接生产库。
- 写操作成功必须能关联命令元数据；失败场景要说明是否产生副作用。
- Worker 只使用 stub/测试消息，不调用真实 provider。

## 脱敏与失败现场

- 永不落盘：密码、Cookie、Authorization、CSRF、OTP、数据库 URL 查询串、AccessKey、stub 控制 token。
- 发现秘密落盘时立即停止并标记 Blocker，不删除证据掩盖问题。
- 失败默认先保存步骤、截图、响应、DB 事实和脱敏日志，再安全 stop/cleanup；不为保留现场长期占用容器或端口。

## 清理

- cleanup 前保存必要的脱敏日志尾部和退出码。
- 只清理匹配当前 RUN_ID 的容器、进程、端口、临时库和证书，不删除未知资源。
- `evidence-manifest.json` 必须记录 repository SHA、结果、资源清理状态和 `secretsRecorded=false`。
