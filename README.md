# Nest Admin & Chat API

一个基于 NestJS 的管理后台和聊天室 API 系统，支持用户管理、内容管理、实时聊天等功能。

## 🏗️ 项目结构

```
src/
├── shared/              # 共享模块
│   ├── auth/           # 认证相关
│   ├── user/           # 用户管理
│   ├── database/       # 数据库配置
│   ├── common/         # 通用工具
│   └── validation/     # 数据验证
├── admin/              # 管理后台模块
│   ├── articles/       # 文章管理
│   ├── users/          # 用户管理
│   ├── permissions/    # 权限管理
│   ├── dashboard/      # 仪表板
│   └── audit/          # 审计日志
└── chat/               # 聊天API模块
    ├── rooms/          # 房间管理
    ├── messages/       # 消息管理
    ├── presence/       # 在线状态
    └── websocket/      # WebSocket
```

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置数据库连接等信息。

### 3. 设置数据库

```bash
# 生成 Prisma 客户端
pnpm prisma:generate

# 运行数据库迁移
pnpm prisma:migrate

# 填充初始数据
pnpm prisma:seed
```

### 4. 启动开发服务器

```bash
# 开发模式
pnpm start:dev

# 生产模式
pnpm build
pnpm start:prod
```

## 📚 API 文档

启动应用后，访问以下地址查看 API 文档：

- Swagger UI: http://localhost:3000/docs
- 管理后台 API: http://localhost:3000/api/admin
- 聊天 API: http://localhost:3000/api/chat

## 🔐 默认用户

系统初始化后会创建以下默认用户：

- **管理员**: admin@example.com / admin123
- **版主**: moderator@example.com / mod123
- **普通用户**: user@example.com / user123

## 📋 主要功能

### 管理后台
- 用户管理（CRUD、权限分配）
- 文章管理（创建、审核、发布）
- 权限管理（角色、权限控制）
- 数据分析（用户统计、活跃度）

### 聊天系统
- 多种聊天室（公开群聊、私聊）
- 实时消息传递
- 文件分享
- 消息历史搜索（6个月内）
- 管理员权限管理

### 关于用户错误异常处理与请求格式统一封装
- 业务层面的报错，比如登陆时候，密码错误，邮箱不存在等
1. 目前先简单处理，后续根据需求再完善
2. 统一返回格式，包含result、message、data、code 等字段
3. result 为 true 表示成功，false 表示失败
4. 正常相应code 为 200
- 程序处理层面的报错，比如数据库连接失败，Redis 连接失败，网络错误等
1. 目前先简单处理，后续根据需求再完善
2. 先捕获异常，再根据异常类型返回不同的错误信息
3. 统一返回格式，包含result、message、data、code 等字段，不要timestamp 字段
4. 异常相应code 为 500
## 🛠️ 技术栈

- **后端**: NestJS, TypeScript
- **数据库**: PostgreSQL, Prisma
- **认证**: JWT + Passport
- **实时通信**: WebSocket, Socket.io
- **队列**: Bull Redis Queue
- **文档**: Swagger
- **缓存**: Redis

## 📝 开发指南

### 创建新模块

1. 在相应目录下创建模块结构：
   ```
   src/admin/users/
   ├── users.controller.ts
   ├── users.service.ts
   ├── users.module.ts
   ├── dto/
   │   └── user.dto.ts
   └── entities/
       └── user.entity.ts
   ```

2. 在 `app.module.ts` 中导入模块

3. 配置路由和权限

### 数据库操作

使用 Prisma 进行数据库操作，参考 `prisma/schema.prisma` 定义数据模型。

### 认证和权限

使用 `@Auth()` 装饰器保护路由，使用 `@Roles('ADMIN')` 限制角色访问。

## 🧪 测试

```bash
# 运行所有测试
pnpm test

# 运行特定测试
pnpm test:watch

# 生成测试覆盖率
pnpm test:cov
```

## 📦 部署

### Docker

```bash
# 构建镜像
docker build -t nest-admin .

# 运行容器
docker run -p 3000:3000 nest-admin
```

### 生产环境

1. 配置环境变量
2. 构建项目：`pnpm build`
3. 运行迁移：`pnpm prisma:migrate:deploy`
4. 启动服务：`pnpm start:prod`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
