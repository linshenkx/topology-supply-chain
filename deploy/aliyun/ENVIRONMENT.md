# 环境变量责任合同

阿里云/RDS MySQL/OSS 是生产主链；D1/Vinext/Sites 只用于开发预览与兼容。变量所有权以 `scripts/environment-contract.mjs` 为机器可校验事实源，`pnpm deploy:check-env-contract` 同时解析模板、Compose 插值、硬编码 environment 和标准化 `docker compose config`，拒绝未登记变量、未声明消费者或模板中的真实 secret 值。

## 生产必需与条件必需

| 变量 | Owner / 消费者 | 责任 |
| --- | --- | --- |
| `APP_BASE_URL` | Web / Web | 生产必须为 `https://scm.topologygz.com` |
| `SESSION_SECRET`, `JOB_TOKEN` | Web / Web | 独立随机 secret，不复用 |
| `API_SESSION_SIGNING_KEY` | Identity / Web+API | 独立于 Web session secret |
| `OTP_SEALING_KEY_ID`, `OTP_SEALING_KEY` | Identity / API | API 当前 key id 与单 key |
| `OTP_SEALING_KEYS_JSON` | Identity / Worker | Worker keyring 必须包含 API 当前 key id 对应的 key |
| `DATABASE_URL` | Database / Web+API+Worker+Migrator | 内网 MySQL URL；生命周期仍由各 runtime 独立拥有 |
| `OSS_REGION`, `OSS_BUCKET` | Files / Web+API | 私有 OSS 定位 |
| `OSS_ECS_RAM_ROLE` 或 `OSS_ACCESS_KEY_ID`+`OSS_ACCESS_KEY_SECRET` | Files / Web+API | 优先 RAM role；静态 key 只作为成对兼容配置 |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_API_KEY` | Notifications / Web+Worker | Web SMS 兼容发送与 Worker 异步发送共享 endpoint 凭据 |
| `SMS_WEBHOOK_HEALTH_URL`, `EMAIL_*_WEBHOOK_*`, `FILE_SCAN_*_WEBHOOK_*` | Worker / Worker | Worker provider 的 URL、API key、health URL 按 provider 成组配置 |

## 有界默认值

| 变量 | Owner / 消费者 | 默认来源 |
| --- | --- | --- |
| `DB_POOL_SIZE` | Database / Web+API | 模板与 Compose：`10` |
| `DB_CONNECT_TIMEOUT_MS`, `DB_PING_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | API / API | Compose：`5000` / `2000` / `5000` |
| `DB_TRANSACTION_TIMEOUT_MS` | API / API | Compose：`30000` |
| `WORKER_DB_POOL_SIZE` | Worker / Worker | Compose：`5` |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | Database / all MySQL consumers | 生产 `enabled` / `true`；本地测试显式 `disabled` |
| `OSS_INTERNAL_ENDPOINT` | Files / Web+API | 生产同地域默认 `true`，本地示例 `false` |
| `APP_ENV` | Repository / Web+API | Compose 固定 production；不得用于隐式 writer activation |
| `DEPLOY_TARGET` | Repository / Web+API+Migrator | Compose 固定 aliyun；不得用于隐式 writer activation |
| `DOMAIN_REGISTRATION_MODULES` | API / API | Compose 固定 R2+R3 canonical manifest；不是可随意删减的 operator 开关 |
| `NODE_ENV`, `HOST`, `PORT`, `WORKER_INTERNAL_URL` | Runtime/API / 对应进程 | Compose 中的硬编码 runtime 边界同样受机器合同覆盖，不再漏检 |

## 发布参数与 secret 边界

`APP_IMAGE_TAG`、`API_IMAGE_TAG`、`WORKER_IMAGE_TAG` 由 `deploy.sh`/`rollback.sh` 从同一 `RELEASE_TAG` 派生，不进入长期 env 模板。`CURRENT_RELEASE_MANIFEST_JSON`、`TARGET_RELEASE_MANIFEST_JSON`、`WRITER_ACTIVATION_RESOURCES` 与 `WRITER_ACTIVATION_EVIDENCE_SHA256` 是单次命令证据，不属于 runtime 环境。

Web、API、Worker 三个长期进程均使用 Compose 显式 allowlist。Web 不再加载整份 `.env.production`，因此不会获得 Email、File-scan、Worker OTP keyring 或 Worker pool 配置；它仍显式获得自身 DB/OSS/session/SMS 兼容路径所需变量。在长期 runtime 中，Worker 独占 Email/File-scan/OTP keyring secret；SMS endpoint/API key 因 Web 兼容发送路径而由 Web 与 Worker 共同消费。

`MIGRATOR_ENV_FILE_OVERINJECTION_DEBT`：短生命周期 migrator 仍通过 `env_file: .env.production` 获得完整生产变量集，因为既有 deploy 在该镜像中先运行全量 `check-production-env.mjs` 再执行 migration/history/drain 门禁。它因此也能读取并不由 migration 消费的 provider secret；这是明确未闭合的过度注入债务，不属于长期 runtime 隔离。移除它需要单独重构生产预检凭据加载/执行位置，本次不改变 deploy、release、fence 或 migration 语义。

普通 deploy 不设置 writer activation allowlist，也不改变 `writer_fences`。生产值只放在服务器的 ignored `.env.production` 或批准的外部 secret 管理中。
