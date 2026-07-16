# Nest Admin Chat Backend

基于 NestJS、Prisma 和 Socket.IO 构建的聊天业务后端。项目提供 JWT 认证、好友与通知、单聊与群聊、可靠消息同步、文件存储、收藏，以及房间级 AI 聊天总结和回复建议。

> 本仓库目前是后端服务，不包含 Web、Electron 或移动端界面。客户端接入约定位于 `docs/`。

## 功能概览

- 用户与认证：注册、登录、JWT 鉴权、Token 刷新和会话控制。
- 实时聊天：单聊、群聊、成员管理、在线状态和 Socket.IO 事件推送。
- 可靠消息：客户端消息 ID 幂等、送达确认、断线增量同步和未读数。
- 消息能力：文本、图片、文件、音频、视频，以及个人聊天记录清空。
- 好友与通知：好友关系、好友申请、通知读取和处理。
- 文件存储：通过 MinIO 上传和访问聊天文件。
- 收藏：收藏消息、图片、视频、文件和聊天记录快照。
- AI 助手：聊天摘要、关键要点、待办事项和多条回复建议。
- 基础设施：PostgreSQL、Redis、Bull、RabbitMQ、结构化日志和 Swagger。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 运行时 | Node.js、TypeScript、NestJS 11 |
| 数据库 | PostgreSQL、Prisma 5 |
| 鉴权 | Passport、JWT |
| 实时通信 | Socket.IO、NestJS WebSocket Gateway |
| 缓存与任务 | Redis、Bull、RabbitMQ |
| 文件存储 | MinIO |
| AI | OpenAI Responses API / OpenAI-compatible Chat Completions |
| 可观测性 | nestjs-pino、请求 ID、敏感字段脱敏 |
| API 文档 | Swagger |

## 项目结构

```text
.
├── config/                 # 应用、Redis 和环境配置
├── docker/                 # Redis、RabbitMQ、MinIO 本地依赖
├── docs/                   # API、设计文档、故障复盘和接入说明
├── examples/               # 客户端集成示例及使用说明
├── prisma/
│   ├── migrations/         # Prisma 数据库迁移
│   ├── repairs/            # 显式执行的数据库修复/核验 SQL
│   ├── schema.prisma       # 数据模型
│   └── seed.ts             # 初始角色、权限和管理员账号
├── scripts/                # 只读压测等维护脚本
└── src/
    ├── chat/               # HTTP 聊天接口、WebSocket、AI 和聊天业务
    ├── common/             # 鉴权、数据库、Redis、邮件、队列和全局处理
    ├── favorite/           # 收藏
    ├── minio/              # 文件上传
    ├── notification/       # 通知
    ├── user/               # 用户与好友
    ├── app.module.ts       # 根模块
    └── main.ts             # 应用入口、全局前缀和 Swagger
```

## 环境要求

- Node.js 20 或更高版本
- pnpm 10
- PostgreSQL
- Redis
- RabbitMQ
- MinIO
- 可选：OpenAI API 或兼容服务的 API Key，用于聊天 AI 功能

PostgreSQL 需要单独准备；仓库的 `docker/docker-compose.yml` 只负责 Redis、RabbitMQ 和 MinIO。

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

至少需要正确配置：

```dotenv
DATABASE_URL="postgresql://username:password@localhost:5432/nest_admin"
JWT_SECRET="replace-with-a-long-random-secret"
JWT_REFRESH_SECRET="replace-with-another-long-random-secret"
REDIS_HOST="127.0.0.1"
REDIS_PORT=6379
REDIS_PASSWORD="replace-with-redis-password"
```

不要提交 `.env`，也不要把数据库密码、JWT Secret、MinIO Secret 或模型 API Key 写入源码和文档。

### 3. 启动本地依赖

确保 `.env` 中已设置 Redis、RabbitMQ 和 MinIO 所需的账号密码，然后运行：

```bash
docker compose -f docker/docker-compose.yml up -d
```

默认仅监听本机：

- Redis：`127.0.0.1:6379`
- RabbitMQ：`127.0.0.1:5672`
- RabbitMQ 管理台：`http://127.0.0.1:15672`
- MinIO API：`http://127.0.0.1:9000`
- MinIO Console：`http://127.0.0.1:9001`

### 4. 初始化数据库

```bash
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm prisma:seed
```

开发新迁移时使用 `pnpm prisma:migrate`；已有环境启动时使用 `pnpm prisma:migrate:deploy`。

`pnpm prisma:seed` 会创建演示用后台账号。它们只适合本地开发，部署环境必须删除或修改默认密码。

### 5. 启动服务

```bash
pnpm start:dev
```

默认地址：

- HTTP API：`http://localhost:3000/api`
- Swagger：`http://localhost:3000/docs`
- Socket.IO：与 HTTP 服务共用端口，默认路径为 `/socket.io`

端口和 API 前缀由 `PORT`、`GLOBAL_PREFIX` 控制。

## AI 配置

聊天 AI 接口仅在服务端读取模型凭据：

```dotenv
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="https://api.openai.com/v1"
MODEL_NAME="gpt-4.1-mini"
AI_API_MODE="auto"
AI_TIMEOUT_MS=30000
AI_MAX_INPUT_CHARACTERS=30000
AI_RATE_LIMIT_WINDOW_MS=5000
```

`AI_API_MODE` 支持：

- `auto`：根据模型选择 Responses API 或 Chat Completions。
- `responses`：强制调用 `/responses`，使用 JSON Schema 结构化输出。
- `chat-completions`：强制调用 `/chat/completions`，适配兼容服务。

AI 接口：

```text
POST /api/chat/rooms/:roomId/ai/summary
POST /api/chat/rooms/:roomId/ai/reply-suggestions
```

后端只向模型提交经过筛选的发送者名称、时间、消息类型和文本。文件及媒体消息只提交文件名，不上传文件二进制。详细约束见 `docs/chat-ai-summary-reply-design.md`。

## API 与实时事件

所有非公开 HTTP 路由默认受全局 JWT Guard 保护，请使用：

```http
Authorization: Bearer <access-token>
```

成功响应统一为：

```json
{
  "result": true,
  "code": 0,
  "data": {},
  "message": "操作成功"
}
```

异常响应使用对应 HTTP 状态码，并保持 `result`、`code`、`data`、`message` 和 `path` 字段。

进一步文档：

- `docs/api.md`：API 总览
- `docs/user-http-api.md`：用户 HTTP API
- `docs/chat-http-api.md`：聊天 HTTP API
- `docs/websocket-realtime-events.md`：WebSocket 事件
- `docs/frontend-reliable-message-integration.md`：可靠消息客户端接入
- `docs/favorite-http-api.md`：收藏 API
- `docs/jwt-auth-flow.md`：JWT 流程
- `docs/rabbitmq-mail-queue-design.md`：邮件队列设计

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm start:dev` | Watch 模式启动开发服务 |
| `pnpm build` | 编译 NestJS 项目 |
| `pnpm start:prod` | 运行 `dist/main` |
| `pnpm prisma:generate` | 生成 Prisma Client |
| `pnpm prisma:migrate` | 创建并应用开发迁移 |
| `pnpm prisma:migrate:deploy` | 部署已有迁移 |
| `pnpm prisma:seed` | 写入本地演示数据 |
| `pnpm prisma:studio` | 打开 Prisma Studio |
| `pnpm load:test:readonly` | 执行只读 API 压测脚本 |

`package.json` 保留了 Jest 和 ESLint 脚本，但当前仓库尚未完整配置对应依赖和测试目录。提交前的可靠基线是 `pnpm build`；补齐测试基础设施后再将 `pnpm test`、`pnpm lint` 作为强制检查。

## 数据库变更

1. 修改 `prisma/schema.prisma`。
2. 执行 `pnpm prisma:migrate` 创建迁移。
3. 检查生成的 SQL，避免破坏已有数据。
4. 执行 `pnpm prisma:generate`。
5. 执行 `pnpm build`。

不要直接修改已经发布的迁移。`prisma/repairs/` 中的 SQL 是显式运维工具，不会随 Prisma migration 自动执行。

## 生产部署

### Docker 镜像

仓库根目录提供多阶段构建的 `Dockerfile`：

```bash
docker build -t nest-admin-chat:latest .
```

Dockerfile 默认通过 npm 官方源安装 pnpm 和项目依赖。如果部署环境访问官方源较慢，可在构建时切换到国内镜像：

```bash
docker build \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t nest-admin-chat:latest .
```

也可以通过 `PNPM_VERSION` 覆盖 pnpm 版本，但通常应保持与 `package.json` 的 `packageManager` 一致。

容器只包含编译产物、Prisma Client 和生产依赖，并使用非 root 用户运行。启动时通过环境变量或 Docker Secret 注入配置，不要把 `.env` 复制进镜像：

```bash
docker run --rm \
  --name nest-admin-chat \
  --env-file .env \
  -p 3000:3000 \
  nest-admin-chat:latest
```

数据库迁移应作为部署阶段的独立任务执行，而不是每个应用容器启动时自动执行：

```bash
docker run --rm \
  --env-file .env \
  nest-admin-chat:latest \
  pnpm prisma:migrate:deploy
```

容器内的 HTTP 和 Socket.IO 共用 `3000` 端口。若使用 Kubernetes 或 Docker Compose，应为 PostgreSQL、Redis、RabbitMQ 和 MinIO 配置独立服务地址，不能使用容器内的 `localhost`。

### 直接部署

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm build
pnpm prisma:migrate:deploy
pnpm start:prod
```

生产环境还应完成：

- 使用密钥管理服务保存所有 Secret。
- 更换 Seed 默认账号，或禁止在生产执行 Seed。
- 为 PostgreSQL、Redis、RabbitMQ 和 MinIO 配置持久化、备份与访问控制。
- 通过反向代理启用 HTTPS 和 WebSocket Upgrade。
- 根据部署拓扑调整 AI 限流；当前进程内限流不适用于多实例全局配额。

## Codex 协作

项目主要通过 Codex 迭代。仓库级开发规范、验证要求和安全边界记录在 `AGENTS.md`。Codex 和人工贡献者都应以当前代码、Prisma schema、迁移及 `docs/` 中的契约为依据，并保持改动范围清晰可审查。

## License

项目 `package.json` 当前声明为 ISC。
