# Stage 6 Scope A Closure Notes

## Wave 1：MySQL migration历史与可重复工程基线

- 本地Git证据显示`0000`/`0001`在初始提交后被原地改写；没有发现生产数据库或生产凭据证据，未推断生产已应用状态。
- MySQL 8.4.11 oracle确认初始`0000`在首个外键处因`SERIAL`主键的`BIGINT UNSIGNED`与引用列`INT`不兼容而失败，Drizzle不会记录完成history。因此冻结当前可完整执行的`0000`至`0004`为唯一canonical manifest，不承诺兼容初始hash，也不修改`__drizzle_migrations`冒充历史。
- preflight现同时冻结SQL/snapshot hash、journal顺序/时间戳，并要求数据库history为`hash + created_at`严格前缀；非空无history、未知/初始hash、时间戳错位和额外history均fail closed。
- `@alicloud/openapi-core`的`allowBuilds`已明确设为`false`；该纯JavaScript SDK不获准运行安装构建脚本，frozen install无需lockfile变化。
- 生产门禁仍要求数据库负责人只读导出并核对真实ordered history；本任务没有连接生产数据库、读取生产凭据或改写生产history。
