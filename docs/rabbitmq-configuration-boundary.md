# RabbitMQ 配置边界与拓扑管理

## 问题背景

邮件队列第一版把 Exchange、Queue、Routing Key、重试参数全部映射为环境变量。这样看起来灵活，但会带来两个问题：

1. `.env` 中出现大量只在应用内部使用的名称，配置噪声较大。
2. Producer、Consumer 和 Binding Key 可以被分别修改，容易形成不兼容配置。

例如只修改 Producer 的 Routing Key，但没有同步修改 Queue 的 Binding Key，`channel.publish()` 仍可能执行成功，消息却不会进入目标队列。

## 配置分类原则

RabbitMQ 配置分为三类：

| 类型 | 示例 | 存放位置 |
| --- | --- | --- |
| 连接和凭据 | URL、Host、Port、Username、Password、VHost | 环境变量 |
| 运行参数 | Consumer 开关、重试次数、重试间隔、Prefetch | 环境变量 |
| 应用内部协议 | Exchange、Queue、Routing Key、Binding Key | TypeScript 常量 |

判断标准是：

> 不同部署环境确实不同的值放环境变量；必须由 Producer 和 Consumer 保持一致的协议名称放代码。

## 当前环境变量

连接配置推荐优先使用一个 URL：

```env
RABBITMQ_URL=amqp://username:password@127.0.0.1:5672
```

如果未设置 URL，项目仍支持使用以下字段构造连接：

```env
RABBITMQ_HOST=127.0.0.1
RABBITMQ_PORT=5672
RABBITMQ_USERNAME=admin
RABBITMQ_PASSWORD=change-me
RABBITMQ_VHOST=/
```

邮件 Consumer 只保留少量可调运行参数：

```env
RABBITMQ_MAIL_CONSUMER_ENABLED=true
MAIL_RETRY_DELAY_MS=10000
MAIL_MAX_RETRY=3
MAIL_PREFETCH=5
```

这些参数都有默认值，不需要为了使用默认行为而写入 `.env`。

`RABBITMQ_VERSION_TAG` 只供 Docker Compose 选择镜像版本，不进入 NestJS 业务配置。

## 当前代码结构

RabbitMQ 拓扑集中定义在：

```text
src/common/core/constants/rabbitmq-topology.constant.ts
```

共享 Exchange：

```ts
export const RABBITMQ_EXCHANGES = {
  events: 'app.events',
  retry: 'app.events.retry',
  deadLetter: 'app.events.dlx',
} as const;
```

邮件领域拓扑：

```ts
export const MAIL_VERIFICATION_TOPOLOGY = {
  queue: 'mail.verification.send.queue',
  retryQueue: 'mail.verification.send.retry.queue',
  deadLetterQueue: 'mail.verification.send.dlq',
  routingKey: 'mail.verification.send',
  retryRoutingKey: 'mail.verification.send.retry',
  deadLetterRoutingKey: 'mail.verification.send.dlq',
} as const;
```

这让拓扑名称可以被代码搜索、代码审查和版本控制，不会因为某台服务器的 `.env` 不同而悄悄改变消息协议。

## 后续聊天消息审核

聊天审核可以继续使用共享 Topic Exchange，但应使用独立 Queue 和 Routing Key：

```ts
export const CHAT_MODERATION_TOPOLOGY = {
  queue: 'chat.moderation.requested.queue',
  retryQueue: 'chat.moderation.requested.retry.queue',
  deadLetterQueue: 'chat.moderation.requested.dlq',
  routingKey: 'chat.moderation.requested',
  retryRoutingKey: 'chat.moderation.requested.retry',
  deadLetterRoutingKey: 'chat.moderation.requested.dlq',
} as const;
```

消息流可以设计为：

```text
聊天消息落库
  -> 发布 chat.moderation.requested
  -> 审核 Consumer
  -> 审核通过或拒绝
  -> 临时失败进入审核重试队列
  -> 超过次数进入审核 DLQ
```

邮件和聊天审核共享连接封装与 Exchange，但不共享 Queue。这样两个消费者可以独立设置并发、重试次数、告警和扩容策略。

## 为什么暂时保留 RabbitMQ

如果项目只有验证码邮件，BullMQ 会更简单。但后续聊天审核具备以下特点：

- 属于业务事件，而不只是延迟任务。
- 可能增加 AI 审核、规则审核、审计记录等多个消费者。
- 需要独立路由、失败隔离、重试和 DLQ。
- 将来可能拆分为独立服务。

因此当前保留 RabbitMQ 是合理的。此次重构不是删除可靠消息能力，而是减少不必要的配置自由度。

## 面试表达

> RabbitMQ 第一版把所有 Exchange、Queue 和 Routing Key 都放进环境变量，配置看起来灵活，但这些值实际上是 Producer 与 Consumer 之间的内部协议。分别配置反而可能导致路由不一致，而且 `.env` 很难维护。

> 我把连接地址、凭据、重试次数和 Prefetch 保留为环境配置，把拓扑名称收敛到 TypeScript 常量并纳入版本控制。邮件和未来聊天审核共享 Topic Exchange，但使用各自独立的 Queue、Routing Key、重试队列和 DLQ。这样既降低配置复杂度，也保留了 RabbitMQ 对多业务事件和多消费者的扩展能力。

