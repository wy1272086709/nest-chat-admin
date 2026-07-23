# 聊天消息后端链路检查记录

## 1. 检查目的

本文记录聊天消息发送与敏感内容审核链路的静态检查结果，便于后续联调、修复和上线验收。

本次检查重点包括：

- WebSocket 消息发送与服务端回执。
- 消息幂等和数据库落库。
- 异步内容审核、失败重试和审核结果落库。
- 违规消息正文替换与实时通知。
- 历史消息、断线同步、送达状态和会话清空。

## 2. 当前结论

聊天消息的主要后端链路已经在代码层面闭环，项目可以正常构建。默认配置下，文本消息采用异步审核，因此消息会先落库并实时展示，审核完成后再处理违规内容。

当前结论仅代表代码静态检查和构建通过，不等同于 RabbitMQ、数据库、AI 服务及客户端已经完成端到端联调。

## 3. 消息发送链路

### 3.1 群聊消息

客户端通过 `message:sendRoom` 发送消息：

1. Gateway 从已认证的 Socket 获取用户 ID，不接受客户端提交发送者 ID。
2. Service 校验发送者是房间的 `ACTIVE` 成员。
3. 使用 `senderId + clientMessageId` 查询重复消息。
4. 检查用户是否处于禁言状态。
5. 根据审核模式执行同步审核，或创建异步审核 Outbox 记录。
6. 消息及 Outbox 记录在同一个数据库事务中写入。
7. 非重复消息通过 `message:new` 广播到房间。
8. 发送方通过 `message:sent` 事件和 Socket.IO ack 获得服务端消息 ID。

### 3.2 私聊消息

客户端通过 `message:sendPrivate` 发送消息：

1. 禁止给自己发送私聊消息。
2. 校验接收者存在。
3. 按双方用户 ID 排序生成稳定的私聊房间名称。
4. 已存在的私聊房间会恢复双方成员的 `ACTIVE` 状态；不存在时进行懒创建。
5. 复用群聊消息落库与审核逻辑。
6. 通过接收者的 `user:{userId}` 房间推送 `message:new`。
7. 发送方通过 `message:sent` 和 ack 获取确认，避免重复收到自己的实时消息。

### 3.3 幂等保证

数据库存在 `@@unique([senderId, clientMessageId])` 唯一约束。并发重试触发 Prisma `P2002` 时，Service 会重新查询已落库消息并作为重复请求返回。

客户端应为每一条逻辑消息生成稳定且唯一的 `clientMessageId`，超时重试时继续使用原值。

## 4. 异步内容审核链路

默认审核模式为 `async`，链路如下：

```text
客户端发送文本消息
  -> 消息落库，moderationStatus=PENDING
  -> 同一事务写入 moderation_outbox
  -> Outbox Publisher 发布 RabbitMQ 事件
  -> ChatModerationConsumer 消费事件
  -> 调用 AI 服务进行内容判定
  -> 保存 MessageModeration 记录
  -> 更新 Message.moderationStatus
  -> REJECT 时替换数据库中的消息正文
  -> 向房间成员推送 message:moderated
```

### 4.1 审核结果

| 判定 | 消息状态 | 当前行为 |
| --- | --- | --- |
| `PASS` | `PASSED` | 保留原消息 |
| `REVIEW` | `REVIEW` | 保留原消息，等待后续人工处理能力 |
| `REJECT` | `REJECTED` | 启用动作时替换正文并推送实时事件 |
| `DEGRADED` | `DEGRADED` | 审核服务不可用或重试耗尽，消息暂不拦截 |

违规消息的数据库正文会被替换为：

```text
该消息涉及敏感言论，无法展示
```

实时事件为 `message:moderated`，客户端应按 `messageId` 原位替换本地消息正文。即使实时通知丢失，后续历史查询或同步也会读取数据库中的占位正文。

### 4.2 可靠性措施

- 消息与 Outbox 事件在同一事务中写入，避免消息落库但审核任务丢失。
- Outbox Publisher 支持抢占锁、失败重试、最大尝试次数和过期数据清理。
- RabbitMQ 消费失败会进入延迟重试队列。
- 超过最大重试次数后进入死信队列，并将消息标记为 `DEGRADED`。
- `MessageModeration.eventId` 唯一约束保证消费者幂等。
- 审核结果已经写入但后置动作中断时，消息重新投递会再次尝试执行后置动作。

## 5. 配置前提

代码默认值如下：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_MODERATION_ENABLED` | `true` | 启用内容审核 |
| `AI_MODERATION_MODE` | `async` | 先展示，后异步审核 |
| `AI_MODERATION_ACTIONS_ENABLED` | `true` | 对 `REJECT` 消息执行正文替换 |
| `AI_MODERATION_ENFORCEMENT_ENABLED` | `false` | 默认不累计警告或执行禁言 |
| `CHAT_MODERATION_PUBLISHER_ENABLED` | `true` | 启用 Outbox 发布器 |
| `CHAT_MODERATION_CONSUMER_ENABLED` | `true` | 启用审核消费者 |

实际运行还要求：

- 正确配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和可用模型。
- PostgreSQL 已执行相关 Prisma migrations。
- RabbitMQ 可连接，审核交换机和队列可正常创建。
- Publisher 和 Consumer 所在实例持续运行。
- 客户端监听并正确处理 `message:moderated`。

缺少 AI API Key 时，审核结果会进入 `DEGRADED`，不会把敏感正文替换为占位文本。

## 6. 已发现问题

### 6.1 断线同步未遵守会话清空状态

`getMessages()` 会读取 `ChatClearState`，只返回 `clearedAt` 之后的消息；但 `syncMessages()` 当前没有应用相同过滤条件。

影响：用户执行“清空会话”后，如果客户端重新连接并调用 `message:sync`，清空时间之前的消息可能重新出现在客户端。

建议：在无游标同步、游标校验和游标后查询中统一应用当前用户的 `clearedAt` 条件，并明确清空前游标的处理策略。

### 6.2 异步审核存在短暂暴露窗口

`async` 模式下，消息会先通过 `message:new` 展示，之后才由消费者审核。RabbitMQ 积压、AI 超时或客户端未处理 `message:moderated` 时，违规内容可见时间会延长。

这属于当前架构的明确权衡，不是代码执行错误。若产品要求敏感内容不能先展示，应考虑：

- 改用 `AI_MODERATION_MODE=sync`；或
- 在客户端对 `PENDING` 消息使用待审核展示状态；或
- 增加高置信本地规则，在消息广播前完成快速拦截。

### 6.3 尚无完整自动化测试证明端到端行为

仓库当前没有覆盖以下链路的完整测试：

- Socket 鉴权、消息发送、ack 与实时推送。
- Outbox 发布、RabbitMQ 重试与死信。
- AI 返回 `PASS`、`REVIEW`、`REJECT`、超时和异常响应。
- 审核动作中断后的重复消费。
- 清空会话后的历史查询和断线同步。

当前已执行 `pnpm build`，构建通过。

## 7. 后续验证清单

建议在测试环境按以下顺序验收：

1. 执行 `prisma migrate status`，确认审核相关迁移已应用。
2. 检查 RabbitMQ 的请求队列、重试队列和死信队列已经创建。
3. 使用两个用户建立 Socket.IO 连接并加入同一会话。
4. 发送普通文本，确认发送 ack、`message:new` 和最终 `PASSED` 状态。
5. 发送明确违规文本，确认消息先为 `PENDING`，之后正文被替换并收到 `message:moderated`。
6. 接收方离线后发送消息，重新上线调用 `message:sync`，确认消息可恢复且不重复。
7. 对同一个 `clientMessageId` 连续发送两次，确认数据库仅存在一条消息。
8. 暂停 AI 服务或制造超时，确认消息重试、死信和 `DEGRADED` 状态符合预期。
9. 清空会话后执行历史查询和断线同步，验证修复后的可见范围一致。
10. 启用处罚功能前，先在 `shadow` 模式观察误判率和分类分布。

## 8. 相关代码

- `src/chat/chat.gateway.ts`：Socket 鉴权、消息事件和实时推送。
- `src/chat/chat.service.ts`：成员校验、消息落库、历史和同步。
- `src/chat/moderation/chat-moderation.service.ts`：AI 审核请求与结果校验。
- `src/chat/moderation/chat-moderation-outbox.publisher.ts`：Outbox 发布。
- `src/chat/moderation/chat-moderation.consumer.ts`：RabbitMQ 消费、重试和审核结果落库。
- `src/chat/moderation/chat-moderation-action.service.ts`：违规正文替换和实时通知。
- `src/chat/moderation/chat-moderation-enforcement.service.ts`：警告和禁言。
- `prisma/schema.prisma`：消息、审核、Outbox 和限制相关数据模型。

