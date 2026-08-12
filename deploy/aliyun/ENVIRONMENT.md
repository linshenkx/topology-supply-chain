# 环境变量责任合同

阿里云/RDS MySQL/OSS 是生产主链；D1/Vinext/Sites 只用于开发预览与兼容。变量所有权以 `scripts/environment-contract.mjs` 为机器可校验事实源，`pnpm deploy:check-env-contract` 保证本地模板、生产模板和 Compose 没有未登记变量或真实 secret 值。

## 生产必需与条件必需

| 变量 | Owner / 消费者 | 责任 |
| --- | --- | --- |
| `APP_BASE_URL` | Web / Web | 生产必须为 `https://scm.topologygz.com` |
| `SESSION_SECRET`, `JOB_TOKEN` | Web / Web | 独立随机 secret，不复用 |
| `API_SESSION_SIGNING_KEY` | Identity / Web+API | 独立于 Web session secret |
| `OTP_SEALING_KEY_ID`, `OTP_SEALING_KEY`, `OTP_SEALING_KEYS_JSON` | Identity / API+Worker | 当前 key id、API 单 key 与 Worker keyring 必须对应 |
| `DATABASE_URL` | Database / Web+API+Worker+Migrator | 内网 MySQL URL；生命周期仍由各 runtime 独立拥有 |
| `OSS_REGION`, `OSS_BUCKET` | Files / Web+API | 私有 OSS 定位 |
| `OSS_ECS_RAM_ROLE` 或 `OSS_ACCESS_KEY_ID`+`OSS_ACCESS_KEY_SECRET` | Files / Web+API | 优先 RAM role；静态 key 只作为成对兼容配置 |
| `SMS_*_WEBHOOK_*`, `EMAIL_*_WEBHOOK_*`, `FILE_SCAN_*_WEBHOOK_*` | Worker / Worker | 每个 provider 的 URL、API key、health URL 必须成组三项配置 |

## 有界默认值

| 变量 | Owner / 消费者 | 默认来源 |
| --- | --- | --- |
| `DB_POOL_SIZE` | Database / Web+API | 模板与 Compose：`10` |
| `DB_CONNECT_TIMEOUT_MS`, `DB_PING_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | API / API | Compose：`5000` / `2000` / `5000` |
| `DB_TRANSACTION_TIMEOUT_MS` | API / API | Compose：`30000` |
| `WORKER_DB_POOL_SIZE` | Worker / Worker | Compose：`5` |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | Database / all MySQL consumers | 生产 `enabled` / `true`；本地测试显式 `disabled` |
| `OSS_INTERNAL_ENDPOINT` | Files / Web+API | 生产同地域默认 `true`，本地示例 `false` |
| `APP_ENV`, `DEPLOY_TARGET` | Repository / Web+API | Compose 固定 production/aliyun；不得用于隐式 writer activation |
| `DOMAIN_REGISTRATION_MODULES` | API / API | Compose 固定 R2+R3 canonical manifest；不是可随意删减的 operator 开关 |

## 发布参数与 secret 边界

`APP_IMAGE_TAG`、`API_IMAGE_TAG`、`WORKER_IMAGE_TAG` 由 `deploy.sh`/`rollback.sh` 从同一 `RELEASE_TAG` 派生，不进入长期 env 模板。`CURRENT_RELEASE_MANIFEST_JSON`、`TARGET_RELEASE_MANIFEST_JSON`、`WRITER_ACTIVATION_RESOURCES` 与 `WRITER_ACTIVATION_EVIDENCE_SHA256` 是单次命令证据，不属于 runtime 环境。

Compose 只给 API 注入数据库、会话签名、OTP 与 OSS 所需变量；Worker provider secret 只进入 Worker；普通 deploy 不设置 writer activation allowlist，也不改变 `writer_fences`。生产值只放在服务器的 ignored `.env.production` 或批准的外部 secret 管理中。
