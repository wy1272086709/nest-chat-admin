# RabbitMQ Docker 接入排障记录

## 背景

本项目把邮件验证码发送从同步 SMTP 调用改成 RabbitMQ 异步队列后，本地开发需要启动 RabbitMQ 服务端。

这次主要遇到的问题集中在 Docker 镜像、Compose 环境变量、端口映射、管理后台和应用连接账号不一致几块。

## 遇到的问题

### 1. 普通 RabbitMQ 镜像没有管理后台

如果镜像使用：

```yaml
image: rabbitmq:3
```

或者：

```yaml
image: rabbitmq:latest
```

默认只提供 RabbitMQ Broker 服务，应用可以通过 `5672` 端口连接，但是没有 Web 管理后台。

如果需要浏览器访问 `http://localhost:15672`，应使用带 management 插件的镜像：

```yaml
image: rabbitmq:3-management
```

端口含义：

- `5672`：AMQP 协议端口，NestJS 后端连接 RabbitMQ 使用。
- `15672`：RabbitMQ Management Web 控制台端口，浏览器访问使用。

### 2. Compose 变量替换和容器环境变量不是一回事

Compose 文件里的 `${ADMIN_LOGIN}`、`${ADMIN_PASSWORD}`、`${SOFTWARE_VERSION_TAG}` 是 Docker Compose 在启动容器前做的变量替换。

例如：

```yaml
environment:
  - RABBITMQ_DEFAULT_USER=${ADMIN_LOGIN}
  - RABBITMQ_DEFAULT_PASS=${ADMIN_PASSWORD}
```

这里 `${ADMIN_LOGIN}` 要在 Compose 解析阶段就能读到。

常见变量来源：

- 当前 shell 环境变量。
- Compose 工作目录下的 `.env`。
- 命令行指定的 `--env-file`。

`env_file` 的作用不同，它主要是把变量注入到容器内部：

```yaml
env_file:
  - ../.env
```

它不等价于告诉 Compose 一定用这个文件做 `${...}` 插值。为了避免误会，本地从 `docker` 目录启动时可以显式指定：

```bash
docker compose --env-file ../.env up -d
```

或者从项目根目录启动：

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

### 3. `172.17.0.1` 不适合作为 macOS 本地端口绑定

`172.17.0.1` 通常是 Linux Docker bridge 网关地址，在 macOS Docker Desktop 环境里不一定存在。

本地开发更推荐：

```yaml
ports:
  - '127.0.0.1:5672:5672'
  - '127.0.0.1:15672:15672'
```

或者简单暴露到本机所有网卡：

```yaml
ports:
  - '5672:5672'
  - '15672:15672'
```

### 4. 数据卷会保留旧账号

RabbitMQ 的 `RABBITMQ_DEFAULT_USER` 和 `RABBITMQ_DEFAULT_PASS` 只在首次初始化数据目录时生效。

如果之前已经用 `./data/:/var/lib/rabbitmq/` 启动过容器，后面再改 `.env` 里的账号密码，旧数据卷里的用户不会自动被覆盖。

如果确认本地数据可以丢弃，可以停掉容器后清理 `docker/data` 再重新启动。不要在生产环境直接删除 RabbitMQ 数据目录。

## 403 ACCESS_REFUSED 问题

报错：

```txt
Handshake terminated by server: 403 (ACCESS-REFUSED) with message
"ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN.
For details see the broker logfile."
```

含义是：客户端已经连到了 RabbitMQ 服务端，但登录账号被拒绝。

本项目里的直接原因是：

- Compose 创建 RabbitMQ 默认用户时使用 `ADMIN_LOGIN` / `ADMIN_PASSWORD`。
- NestJS 应用原来的 RabbitMQ 默认连接地址是 `amqp://guest:guest@127.0.0.1:5672`。
- 如果 RabbitMQ 实际用户是 `admin/123456`，应用却用 `guest/guest` 登录，就会被 RabbitMQ 拒绝。

## 已做修复

已调整 `config/common.ts` 的 RabbitMQ 连接地址生成逻辑：

1. 如果配置了 `RABBITMQ_URL`，优先使用完整连接地址。
2. 否则读取 `RABBITMQ_USERNAME` / `RABBITMQ_PASSWORD`。
3. 如果没有单独配置 RabbitMQ 用户名密码，则复用现有的 `ADMIN_LOGIN` / `ADMIN_PASSWORD`。
4. 最后才兜底为 `guest/guest`。

这样当前 `.env` 里已有：

```env
ADMIN_LOGIN="admin"
ADMIN_PASSWORD="123456"
```

应用会默认生成：

```env
amqp://admin:123456@127.0.0.1:5672
```

不再错误地使用 `guest/guest`。

## 推荐配置

长期看，建议把 RabbitMQ 的应用连接账号独立出来，避免和管理后台账号混在一起：

```env
RABBITMQ_HOST=127.0.0.1
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=admin
RABBITMQ_PASSWORD=123456
```

也可以直接配置完整 URL：

```env
RABBITMQ_URL=amqp://admin:123456@127.0.0.1:5672
```

如果同时存在，`RABBITMQ_URL` 优先级最高。

## 本地验证步骤

启动 RabbitMQ：

```bash
docker compose --env-file ../.env up -d
```

如果从项目根目录执行：

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

确认端口：

```bash
docker ps
```

浏览器访问：

```txt
http://localhost:15672
```

后端启动后，日志应出现：

```txt
[RabbitMQ] connected
```

如果仍然报 403，优先检查三件事：

- RabbitMQ 容器实际创建的用户名密码。
- NestJS 进程实际加载到的 `.env`。
- `docker/data` 是否保留了旧 RabbitMQ 用户数据。
