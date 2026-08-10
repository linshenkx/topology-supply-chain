# 拓扑供应链进销存管理系统

广州拓扑睡眠科技有限公司面向内部供应链、财务、质检人员，以及组装工厂、配件/辅料供应商和收货方使用的供应链协同系统。

系统覆盖采购计划与采购单、供应商分层、BOM、生产、质检、批次库存、发货退货、财务结算、审批、操作审计和供应商绩效等业务。

> 项目详细进度、待办事项和上线阻塞项请查看 [PROJECT_STATUS.md](./PROJECT_STATUS.md)。该文件是当前项目状态的主要记录。

## 当前生产基线

更新日期：2026-08-04

| 项目 | 当前状态 |
| --- | --- |
| 生产构建 | 成功 |
| `topology-scm` 服务 | `active` |
| 应用健康检查 | `ok` |
| RDS MySQL 健康检查 | `ok` |
| OSS 健康检查 | `ok` |
| 生产域名 | `scm.topologygz.com` |
| ICP/接入备案 | 最后已知状态为管局审核中，需以阿里云备案控制台最新结果为准 |
| HTTPS | 待备案放行后申请证书并启用 |

健康检查命令：

```bash
curl --max-time 30 -sS http://127.0.0.1:3000/api/health
```

预期核心结果：

```json
{
  "status": "ok",
  "checks": {
    "application": "ok",
    "database": "ok",
    "objectStorage": "ok"
  }
}
```

备案放行后，用户入口计划为：<https://scm.topologygz.com>

## 技术架构

- Web 框架：Next.js 16、React 19、TypeScript
- 数据库：阿里云 RDS MySQL 8.0
- ORM/迁移：Drizzle ORM、Drizzle Kit
- 文件存储：阿里云 OSS（ECS RAM 角色访问）
- 短信：阿里云短信服务
- Excel：SheetJS (`xlsx`)
- 服务器：阿里云 ECS，Alibaba Cloud Linux 3，华南 3（广州）
- Web 入口：Nginx 反向代理到 `127.0.0.1:3000`
- 进程管理：systemd 服务 `topology-scm`

## 代码目录

```text
app/
  api/                  API 路由
  components/           各业务工作台页面组件
db/                     数据库连接与 Schema
drizzle-mysql/          MySQL 迁移文件
deploy/aliyun/          阿里云部署、回滚及运维脚本
scripts/                环境检查、管理员初始化等脚本
tests/                  业务规则与页面渲染测试
PROJECT_STATUS.md       项目进度、差距及后续路线图
```

## 常用命令

安装依赖：

```bash
pnpm install --frozen-lockfile
```

本地开发：

```bash
pnpm dev
```

阿里云生产构建：

```bash
pnpm build:aliyun
```

测试：

```bash
pnpm test
```

生产环境配置检查：

```bash
pnpm deploy:check-env
```

初始化首位管理员：

```bash
pnpm admin:bootstrap
```

## 生产运维要点

1. 不要把密码、短信密钥、数据库连接串或其他密钥提交到代码仓库、压缩包或聊天记录中。
2. ECS 访问 OSS 应使用 RAM 角色和临时凭证，不使用长期 AccessKey。
3. 项目备份必须放在 `/opt/topology-scm-backups` 等源码目录之外。不要将备份放进 `/opt/topology-scm`，否则 Next.js 构建会扫描备份中的 TypeScript 文件并导致构建失败。
4. 当前生产数据库曾通过 DMS 完成人工字段和外键修正。执行新的 Drizzle 迁移前，必须先核对线上表结构和 `__drizzle_migrations` 基线，禁止直接盲跑迁移。
5. 每次发布均应保留源码与运行版本备份，并在重启后检查 systemd 状态、健康接口和目标业务页面。
6. 备案完成后再配置正式 HTTPS、HTTP 强制跳转和证书自动续期。

## 文档维护规则

- 每次完成一个模块的生产部署和业务验证后，更新 `PROJECT_STATUS.md` 的状态和验证日期。
- “已有代码”不等于“业务验收完成”；文档中必须分别记录。
- 新增或修改数据库结构时，记录迁移文件、DMS 操作、回滚方式和生产验证结果。
- 任何高风险业务规则变更应保留双人审批、审计日志和发布记录。
