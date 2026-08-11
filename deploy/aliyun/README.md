# 广州拓扑供应链系统：阿里云上线方案

生产域名：`scm.topologygz.com`

## 推荐资源

- ECS：运行Web应用及后台任务，优先华南地域。
- RDS MySQL 8：保存采购、库存、审批、财务、权限和操作日志。
- OSS私有Bucket：保存Excel、营业执照、发票、质检照片和物流凭证。
- Redis：保存验证码限流、会话加速和短期任务锁。
- 短信服务：发送新设备、异地登录和高风险操作验证码。
- 邮件服务：发送审批、风险、付款、盘点及逾期通知。
- 日志服务：收集应用日志；业务审计日志仍保存在数据库并保留5年。

## 网络与安全

1. ECS、RDS和Redis放在同一个VPC。
2. RDS和Redis不开放公网访问，只允许ECS安全组访问。
3. OSS使用私有Bucket，业务文件通过后端鉴权读取，不生成永久公开地址。
4. 域名只开放HTTPS，HTTP强制跳转HTTPS。
5. 数据库、OSS、短信、邮件和OpenAI密钥只放在阿里云密钥管理或ECS安全环境变量中。
6. 管理后台限制上传文件类型及20MB大小，敏感下载记录日志并添加水印。

## 备份目标

- RPO：最多丢失1小时数据。
- RTO：4小时内恢复。
- RDS开启自动备份与日志备份。
- 每天生成一次完整业务备份。
- OSS开启版本控制和生命周期规则。
- 每季度进行一次恢复演练并保留报告。

## 上线顺序

1. 创建VPC、交换机和安全组。
2. 创建RDS MySQL 8并建立专用低权限账号。
3. 创建私有OSS Bucket并开启版本控制。
4. 创建ECS并安装容器运行环境。
5. 在安全配置页填写环境变量，禁止通过聊天发送密钥。
6. 执行数据库迁移和基础数据初始化。
7. 创建首位系统管理员并强制首次登录修改临时密码。
8. 配置短信和邮件适配器。
9. 配置 `scm.topologygz.com` DNS与HTTPS证书。
10. 执行冒烟测试、权限测试、备份恢复测试后再开放外部账号。

## 当前迁移状态

交互页面、业务模型和本地接口已经完成。当前本地预览使用D1/R2兼容接口；正式上阿里云前必须完成以下适配：

- 数据库访问层从D1/SQLite迁移到RDS MySQL。
- 文件访问层从R2迁移到OSS。
- 后台提醒任务改为ECS定时任务或阿里云任务调度。
- 短信、邮件和OpenAI密钥通过生产环境安全绑定。

这些适配完成前，不应把本地预览作为正式生产系统开放。

### 已完成

- 已生成82张RDS MySQL业务表的Drizzle模型与首版迁移SQL。
- 已将MySQL唯一索引字段从SQLite `TEXT`转换为MySQL安全的`VARCHAR(191)`。
- 已建立RDS连接池、SSL配置及连接健康检查。
- 已建立私有OSS上传、鉴权下载、临时签名URL及连接健康检查。
- 上传和下载接口在`DEPLOY_TARGET=aliyun`时使用OSS；本地预览继续使用原存储绑定。
- 短信、邮件和定时任务密钥已改为从ECS生产环境变量读取。
- 已增加上线配置检查命令：`pnpm deploy:check-env`。
- 已生成Node/ECS Web与独立API运行镜像、双健康检查及同版本协同发布/回滚脚本。

### 仍在进行

- 将29处SQLite `INSERT ... RETURNING`改为MySQL的`insertId + SELECT`兼容写法。
- 统一MySQL日期时间序列化与事务处理。
- 将数据库入口从D1切换到RDS连接池。

## ECS部署文件

- `bootstrap-ubuntu.sh`：初始化Ubuntu ECS、Docker与Nginx。
- `docker-compose.yml`：运行Web、独立API及一次性数据库迁移容器。
- `.env.production.template`：生产配置模板，真实文件不得提交到Git。
- `nginx-scm.conf`：`scm.topologygz.com` HTTPS反向代理。
- `deploy.sh`：以同一版本构建Web/API，检查配置、执行迁移、发布并等待双服务健康检查。
- `rollback.sh`：按同一历史镜像版本协同回滚Web与API，不自动回滚数据库迁移。
- `install-jobs.sh`：安装提醒与邮件队列systemd定时器。

### Nginx发布门禁

`deploy.sh`只验证Web与API容器的直连就绪状态。首次安装或每次更新代理配置时，服务器操作人员必须依次执行：

```bash
sudo install -m 0644 nginx-scm.conf /etc/nginx/conf.d/scm.conf
sudo nginx -t
sudo systemctl reload nginx
curl -fsS --connect-timeout 2 --max-time 5 https://scm.topologygz.com/api/v1/health/ready
```

任一步失败都不得宣告发布成功；其中配置安装、校验与reload需要服务器权限，不由应用发布脚本擅自执行。

生产Web只监听`127.0.0.1:3000`，独立API只监听`127.0.0.1:3001`；两者均只通过Nginx的80和443端口提供公网入口。
独立API不继承整份`.env.production`；Compose只向其注入MySQL连接及连接池、TLS、超时配置，OSS、短信、邮件和OpenAI密钥继续保持隔离。
RDS使用内网地址，OSS保持私有并使用RAM最小权限账号。
