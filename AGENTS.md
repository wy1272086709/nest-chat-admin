# AGENTS.md

本文档定义 Codex 及其他编码智能体在本仓库中的协作规范，适用于整个仓库。

## 项目背景

- 本仓库是基于 NestJS 11 的聊天业务后端，涵盖认证、通知、收藏、文件存储和房间级 AI 助手。
- 本仓库不包含生产环境前端。客户端契约和接入说明位于 `docs/` 和 `examples/`。
- PostgreSQL 通过 Prisma 访问；Redis 用于缓存、会话、Bull 和实时通信相关状态；RabbitMQ 负责邮件任务；MinIO 存储上传文件。
- HTTP 和 Socket.IO 共用 Nest 应用端口。
- 大多数路由由全局 JWT Guard 保护。公开访问必须通过现有认证装饰器模式显式声明。
- 响应拦截器和全局异常过滤器定义了公开 HTTP 响应结构。新增接口时必须保持该契约。

## 事实来源

修改行为前，按以下顺序检查最接近需求的内容：

1. `src/` 下的运行时代码。
2. `prisma/schema.prisma` 和 `prisma/migrations/` 下按顺序执行的迁移文件。
3. `docs/` 下与功能对应的 API 或设计文档。
4. `config/common.ts`、`.env.example` 和 `src/app.module.ts` 中的模块装配。

文档可能存在滞后。当文档和运行时代码不一致时，应结合周边代码确认预期行为，并在同一改动中更新相关文档。

## 仓库结构

- `src/chat`：聊天 HTTP API、Socket.IO Gateway、可靠消息、房间成员关系和 AI 助手。
- `src/common/auth`：JWT 策略、守卫、装饰器、Token 刷新和认证服务。
- `src/common/core`：Redis、邮件、RabbitMQ、邮件队列、响应转换和异常处理。
- `src/common/database`：全局 Prisma 和数据库 Provider。
- `src/user`：聊天用户、个人资料、好友关系和用户认证接口。
- `src/notification`：好友及群聊相关通知。
- `src/favorite`：收藏记录及展示快照。
- `src/minio`：文件上传和对象存储集成。
- `config`：运行时配置和相关配置工厂。
- `prisma/migrations`：不可变且有序的数据库迁移。
- `prisma/repairs`：需要人工执行的修复与核验 SQL，不属于自动迁移。
- `docs`：API 契约、架构设计、运维手册和故障复盘。

## 工作规则

- 编辑前先阅读目标模块及相邻的 DTO、Controller、Service、Module、Prisma 模型和相关文档。
- 优先沿用现有 NestJS、Prisma、DTO 校验、异常处理和响应封装模式。
- Controller 保持轻量，数据库访问和业务规则放在 Service 中。
- 所有 HTTP 输入都应使用 DTO，并通过 `class-validator` 和 `class-transformer` 校验。
- 读取消息或修改房间级状态前，必须校验当前用户的有效房间成员身份。
- 保留基于 `clientMessageId` 和现有唯一约束的消息幂等机制。
- 保持可靠消息流程和 WebSocket 事件名称稳定。修改事件载荷时，同步更新 `docs/websocket-realtime-events.md` 和客户端示例。
- 避免无关格式化和重构。工作区可能包含用户尚未提交的改动，不得还原或覆盖这些改动。
- 仓库搜索优先使用 `rg` 和 `rg --files`。
- 手工编辑文件使用 `apply_patch`。
- 只有在能消除实际重复或符合现有模块边界时才增加抽象。

## 数据库变更

- 数据库结构变更需要修改 `prisma/schema.prisma` 并新增迁移。
- 不得修改或重新排序已经发布的迁移。
- 检查生成的 SQL 是否包含破坏性操作、全表重写、缺失的数据回填或不合理的索引影响。
- 修改 Prisma Schema 后执行 `pnpm prisma:generate`。
- 多记录业务不变量在部分成功时可能造成数据损坏，应使用事务。
- 不得自动执行 `prisma/repairs` 下的文件，它们需要运维人员明确授权。
- 处理已有生产数据和 Schema Drift 时，参考 `docs/postmortem-*` 和 `docs/*p2022*` 中记录的问题。

## 鉴权和 API 契约

- 默认认为路由需要 JWT 认证，除非该路由被明确设计为公开接口。
- 在现有模块采用该模式时，通过 `@CurrentUser()` 获取已认证的聊天用户。
- 不要捕获 `HttpException` 后将其转换为 HTTP 200。新增接口应保留有意义的 400、403、404、429、502 和 504 状态码。
- 成功响应对象应兼容 `TransformInterceptor`：`{ result, data, message }`。
- 不得暴露堆栈、内部异常详情、密码哈希、Token 或基础设施凭据。
- 新增或修改公开接口时，同步更新 Swagger 注解和相关 `docs/*-api.md` 文档。

## 聊天和实时通信变更

- 聊天历史分页通常按时间倒序返回；模型输入和人类可读的导出可能需要按时间正序。必须显式确认排序方式。
- 排除软删除消息；用户级功能还必须遵守对应的 `ChatClearState`。
- 文件消息可以向有权限的客户端提供元数据和 URL，但 AI Prompt 不得包含二进制内容或内部存储字段。
- 修改房间成员关系时，需要考虑 ACTIVE/INACTIVE 状态、群主转让、未读状态和受影响用户的实时通知。
- Socket.IO Handler 必须认证连接，不得信任客户端直接提交的用户 ID。

## AI 功能变更

- API Key 必须只保存在服务端。不得通过 Controller、Socket.IO 载荷、前端示例、日志或已提交的环境文件暴露。
- 将聊天消息、文件名、草稿和模型输出全部视为不可信输入。
- Prompt 必须防止指令注入，不得执行聊天内容中出现的链接、工具调用或命令。
- 只发送完成任务所需的最少消息字段。不得向模型发送文件二进制；除非经过评审的设计明确增加多模态处理，否则非文本消息只发送文件名。
- 保留消息数量、总字符数、超时和限流约束。
- 即使模型供应商声明支持结构化输出，也必须在解析后校验模型返回值。
- `AI_API_MODE=auto` 当前会将 `qwen-coder*` 路由到 Chat Completions，其他模型路由到 Responses。修改前必须核对供应商和模型的接口支持情况。
- 运营日志可以记录用户 ID、房间 ID、功能、模型、Token 用量、耗时和状态，但普通日志不得记录完整 Prompt 或聊天正文。

## 配置和密钥

- 新增非敏感配置时，同步更新 `config/common.ts`、适用的配置校验和 `.env.example`。
- 不得打印或提交 `.env` 中的真实值。
- 保留现有 Pino 脱敏列表；新增敏感请求字段时应扩展该列表。
- 注意本地 Docker 依赖通过 `docker/docker-compose.yml` 读取 `../.env`。
- 不得引入硬编码的生产凭据或安全性不足的默认 Secret。

## 验证要求

根据改动风险执行相应检查：

- 仅修改文档：检查 Markdown 结构，并对相关文件执行 `git diff --check`。
- 修改 TypeScript 或配置：执行 `pnpm build`。
- 修改 Prisma Schema：执行 `pnpm prisma:generate`，检查迁移，然后执行 `pnpm build`。
- 修改运行时集成：在依赖可用时执行范围最小的相关 Service 或 API 检查，不得使用生产凭据或产生未授权的外部副作用。
- 修改 HTTP 契约：验证实际状态码和响应封装，不能只检查 Service 返回值。

仓库目前声明了 Jest 和 ESLint 脚本，但尚未提交完整的测试和 Lint 配置。只有在补齐基础设施并实际成功执行后，才能声称 `pnpm test` 或 `pnpm lint` 已通过。当前代码验证的最低基线是 `pnpm build`。

## 文档规范

- `README.md` 聚焦于项目启动、架构、运维和功能入口。
- 详细接口契约写入最接近功能的 `docs/*-api.md`。
- 跨客户端实时通信契约写入 `docs/websocket-realtime-events.md` 或 `docs/frontend-reliable-message-integration.md`。
- 不易理解的生产故障和 Schema Drift 应整理为独立复盘文档，不要将零散说明堆积在业务代码注释中。
- 面向项目使用者的文档默认使用中文，除非周边文档已经采用英文。标识符、命令、路径、事件名和环境变量必须保持准确。

## 完成检查清单

完成代码任务前：

- 确认实现符合用户要求和当前仓库模式。
- 检查 `git diff`，不得还原无关的用户改动。
- 确认日志和 Diff 中不存在密钥或聊天正文。
- 根据契约变更同步更新 DTO、模块装配、配置、Swagger 和文档。
- 执行要求的验证命令，并说明无法执行的检查。
