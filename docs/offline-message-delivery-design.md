# 离线消息与不丢消息设计文档

## 1. 结论

当前项目已经具备**可靠投递第一版**：

- 消息发送时先写入数据库 `chat_messages`，再通过 WebSocket 推送。
- 接收方离线时不会收到实时 `message:new`，但消息已落库。
- 接收方重新上线后，可以通过会话列表和历史消息接口拉取遗漏消息。
- 未读数基于 `RoomMember.lastReadAt` 和 `ChatClearState.clearedAt` 计算。
- 发送方可以携带 `clientMessageId`，服务端按 `senderId + clientMessageId` 做幂等，断线重试不会重复落库。
- 已新增增量同步接口/事件，可以按 `afterMessageId` 补拉消息。
- 已新增接收方 `message:delivered` ack，并用 `MessageSyncState` 保存用户在房间内的送达游标。

但当前还没有做到完整的**企业级端到端可靠投递**：

- 没有客户端离线发送队列的服务端协议约束。
- 没有服务端补推/重试队列。
- 没有逐消息、逐接收人的 `MessageDelivery` 收件箱。
- 没有多端同步策略；当前项目仍以单端登录为主。

所以可以这样定义现状：

> **服务端已成功接收并落库的消息不会丢；客户端重试不会重复落库；接收方重连后可以按游标补拉；服务端可以记录接收方送达游标。客户端本地离线队列和服务端补推队列仍需继续配合。**

---

## 2. 当前实现

### 2.1 发送链路

当前 WebSocket 发送入口在 [chat.gateway.ts](../src/chat/chat.gateway.ts)：

| 事件 | 方法 | 说明 |
|---|---|---|
| `message:sendRoom` | `sendRoomMessage` | 发送群聊/房间消息 |
| `message:sendPrivate` | `sendPrivateMessage` | 发送私聊消息 |

核心流程：

```text
客户端 emit message:sendRoom/message:sendPrivate
  -> ChatGateway 获取当前用户
  -> ChatService 校验房间成员/创建私聊房间
  -> 如果带 clientMessageId，先查 senderId + clientMessageId 是否已存在
  -> Prisma 写入 chat_messages
  -> Gateway 推送 message:new
  -> Gateway 给发送方返回 ack / message:sent
```

[chat.service.ts](../src/chat/chat.service.ts) 中 `sendRoomMessage` 会先执行：

```ts
return this.prisma.message.create(...)
```

也就是说，只要发送接口返回成功，消息已经存在数据库中。

如果客户端因为 ack 丢失而重试同一个 `clientMessageId`，服务端会返回已有消息，并且 Gateway 不会再次广播 `message:new`。

### 2.2 离线接收

如果接收方不在线，`message:new` 实时事件不会送达。

但消息已经在 `chat_messages` 中，接收方上线后可以通过：

| 接口/事件 | 作用 |
|---|---|
| `GET /api/chat/rooms` | 获取会话列表、最后一条消息、未读数 |
| `GET /api/chat/rooms/:roomId/messages?take=50` | 获取历史消息 |
| WebSocket `message:list` | 拉取某个房间历史消息 |
| `GET /api/chat/rooms/:roomId/messages/sync?afterMessageId=xxx` | 按消息游标增量同步 |
| WebSocket `message:sync` | WebSocket 版增量同步 |

未读数计算逻辑在 `ChatService.listConversations`：

```text
unreadCount = roomId 相同
  && senderId != 当前用户
  && isDeleted = false
  && createdAt > max(lastReadAt, clearedAt)
```

### 2.3 已读与清空

| 能力 | 表/字段 | 说明 |
|---|---|---|
| 已读 | `RoomMember.lastReadAt` | 用户把房间标记为已读时更新 |
| 清空聊天 | `ChatClearState.clearedAt` | 只对当前用户隐藏该时间点之前的消息 |
| 已送达 | `MessageSyncState.lastDeliveredId/lastDeliveredAt` | 用户收到消息或同步消息后更新 |

这两者只影响历史消息展示和未读数，不删除原消息。

---

## 3. 当前能保证什么

### 3.1 可以保证

| 场景 | 当前表现 |
|---|---|
| 接收方离线，发送方发送成功 | 消息已落库，接收方上线后可通过历史消息拉到 |
| 接收方在线但未加入 `room:{roomId}` | 私聊会通过 `user:{receiverId}` 推送；群聊需要客户端 join room 后才能实时收到 |
| 服务端成功返回发送 ack | 消息已经写入数据库 |
| 发送方 ack 丢失后重试 | 只要复用同一个 `clientMessageId`，服务端返回已有消息，不重复落库 |
| 接收方重连补拉 | 可用 `messages/sync` 或 `message:sync` 按 `afterMessageId` 拉增量 |
| 接收方确认已收到 | 可发 `message:delivered`，服务端更新 `MessageSyncState` |
| 用户清空聊天 | 不删除消息，只对该用户过滤清空前消息 |

### 3.2 不能完全保证

| 场景 | 当前风险 |
|---|---|
| 客户端断网时点击发送 | WebSocket 发不出去，除非客户端自己缓存并重试 |
| 客户端发送请求到达服务端，但 ack 丢失 | 已支持幂等，但前端必须复用同一个 `clientMessageId` |
| 服务端已推送 `message:new`，客户端未处理成功 | 客户端需补发 `message:delivered` 或重连后 `message:sync` |
| 用户长时间离线后只依赖实时事件 | 不能补齐，必须主动拉历史/会话/同步接口 |
| 多端登录 | 当前有单端登录/踢下线逻辑，多端可靠同步不是当前目标 |

---

## 4. 完整可靠投递目标

目标拆成三层：

### 4.1 服务端不丢

服务端只要确认收到发送请求，就必须先落库再返回成功。

要求：

- 消息写入数据库成功后才返回 `message:sent` / ack。
- 推送失败不影响消息落库。
- 发送方拿到服务端 `message.id` 后，认为“服务端已接收”。

当前已实现。

### 4.2 接收方可补齐

接收方掉线、离线、切后台后，重连必须能补齐遗漏消息。

要求：

- 客户端本地保存每个房间最后同步到的消息游标。
- 重连后按房间拉取游标之后的新消息。
- 服务端提供按 cursor 增量拉取接口。

当前已实现 `GET /api/chat/rooms/:roomId/messages/sync` 和 WebSocket `message:sync`。

### 4.3 端到端可确认

服务端知道某用户是否已经收到某条消息。

要求：

- 客户端收到消息后发送 delivery ack。
- 服务端记录用户维度的 delivered 游标或消息状态。
- 必要时可对未送达消息做补推或提示。

当前已实现用户房间维度的送达游标；尚未实现逐消息逐接收人的收件箱。

---

## 5. 推荐数据模型扩展

### 5.1 发送幂等字段

已在 `Message` 增加客户端消息 ID：

```prisma
model Message {
  id              String      @id @default(cuid())
  roomId          String
  senderId        String
  clientMessageId String?
  ...

  @@unique([senderId, clientMessageId])
  @@index([roomId, createdAt])
}
```

用途：

- 客户端断网重试时复用同一个 `clientMessageId`。
- 服务端发现重复发送时返回已有消息，不重复插入。

### 5.2 用户同步游标

已新增每个用户在每个房间的同步状态：

```prisma
model MessageSyncState {
  id              String   @id @default(cuid())
  roomId          String
  userId          String
  lastDeliveredAt DateTime?
  lastDeliveredId String?
  updatedAt       DateTime @updatedAt

  room            ChatRoom @relation(fields: [roomId], references: [id])
  user            ChatUser @relation(fields: [userId], references: [id])

  @@unique([roomId, userId])
  @@index([userId, updatedAt])
  @@map("message_sync_states")
}
```

用途：

- 标记服务端认为客户端已经收到到哪一条。
- 重连时从 `lastDeliveredAt/lastDeliveredId` 之后补拉。

### 5.3 后续可选：逐条收件箱

如果后续要做“每条消息每个接收者”的状态，可以新增：

```prisma
model MessageDelivery {
  id          String    @id @default(cuid())
  messageId   String
  userId      String
  deliveredAt DateTime?
  readAt      DateTime?

  @@unique([messageId, userId])
  @@index([userId, deliveredAt])
  @@map("message_deliveries")
}
```

优点：状态最精细。

缺点：群聊消息会按成员数放大写入量。当前项目如果群成员规模不大可以接受；如果未来做大群，推荐先用游标方案。

---

## 6. 推荐接口与事件设计

### 6.1 发送消息：客户端携带 `clientMessageId`

WebSocket 入参：

```jsonc
{
  "roomId": "room1",
  "clientMessageId": "client-uuid-001",
  "messageType": "TEXT",
  "content": "hello"
}
```

服务端逻辑：

```text
1. 校验用户是房间 ACTIVE 成员
2. 查找 senderId + clientMessageId 是否已存在
3. 已存在：直接返回已有 Message
4. 不存在：创建 Message
5. 返回 ack：{ result: true, data: message }
6. 推送 message:new
```

### 6.2 重连同步

已新增 HTTP 接口：

```http
GET /api/chat/rooms/:roomId/messages/sync?afterMessageId=xxx&take=100
```

以及 WebSocket 事件：

```text
message:sync
```

入参：

```json
{
  "roomId": "room1",
  "afterMessageId": "msg123",
  "take": 100
}
```

返回：

```jsonc
{
  "messages": [],
  "hasMore": false,
  "nextCursor": {
    "messageId": "msg999",
    "createdAt": "2026-07-11T10:00:00.000Z"
  }
}
```

### 6.3 接收确认

已新增 WebSocket 事件：

```text
message:delivered
```

入参：

```json
{
  "roomId": "room1",
  "messageId": "msg999"
}
```

服务端逻辑：

```text
1. 校验当前用户是房间成员
2. 校验 messageId 属于该房间
3. 更新 MessageSyncState.lastDeliveredId / lastDeliveredAt
4. 可选：向发送方推 message:delivered
```

### 6.4 已读

当前已有：

```http
POST /api/chat/rooms/:roomId/read
```

可以继续沿用 `RoomMember.lastReadAt`。

后续如果需要精确到某条消息，建议扩展为：

```json
{
  "lastReadMessageId": "msg999"
}
```

---

## 7. 客户端配合策略

前端/客户端需要做一层本地队列，否则“客户端离线发送”无法保证。

### 7.1 本地发送队列

客户端发送前先生成：

```text
clientMessageId = uuid()
```

本地消息状态：

| 状态 | 含义 |
|---|---|
| `pending` | 本地已创建，尚未发到服务端 |
| `sent` | 服务端已落库，拿到 `message.id` |
| `failed` | 多次重试失败，需要用户手动重发 |

### 7.2 发送流程

```text
用户点击发送
  -> 本地生成 clientMessageId
  -> 本地展示 pending 消息
  -> WebSocket emit，带 ack callback
  -> ack.result=true：替换为服务端 message，状态 sent
  -> ack.result=false/超时：保留 pending，稍后重试
```

### 7.3 重连流程

```text
WebSocket reconnect
  -> 重新认证
  -> 拉 /api/chat/rooms
  -> 对每个有未读或本地打开的房间执行 message:sync
  -> 补齐遗漏消息
  -> 重发 pending 队列
```

---

## 8. 推荐落地顺序

### 阶段一：当前能力固化（已完成）

目标：明确“落库成功即不丢”。

- 保持发送先落库再推送。
- 前端发送必须使用 ack callback。
- 发送成功以服务端返回的 `message.id` 为准。
- 断线后用会话列表 + 历史消息补齐。

### 阶段二：发送幂等（已完成）

目标：避免客户端重试产生重复消息。

- `Message` 增加 `clientMessageId`。
- DTO 增加 `clientMessageId`。
- `sendRoomMessage` 改成幂等 create/find。
- 前端本地队列重试复用同一个 `clientMessageId`。

### 阶段三：增量同步（已完成）

目标：重连后稳定补齐遗漏消息。

- 增加 `message:sync` 或 HTTP sync 接口。
- 支持 `afterMessageId` / `beforeMessageId` cursor。
- 客户端每个房间保存最后同步游标。

### 阶段四：接收确认（已完成第一版）

目标：服务端知道用户是否已收到。

- 增加 `MessageSyncState`。
- 增加 `message:delivered` 事件。
- 可选推送送达状态给发送方。（未做）

### 阶段五：服务端补推/逐条收件箱（未实现）

目标：进一步接近 IM 系统的完整可靠投递。

- 增加 `MessageDelivery`。
- 按接收人记录每条消息的 delivered/read 状态。
- 服务端对未送达消息做补推或提示。
- 支持多端登录时的端级别同步。

---

## 9. 当前项目状态清单

| 能力 | 状态 | 说明 |
|---|---|---|
| 消息落库 | 已有 | `Message` 表持久化 |
| 发送方 ack | 已有 | Gateway 返回 `{ result, data }`，也发 `message:sent` |
| 在线实时推送 | 已有 | `message:new` |
| 离线后拉历史 | 已有 | `getMessages` |
| 未读数 | 已有 | `lastReadAt + clearedAt` |
| 发送幂等 | 已有 | `Message.clientMessageId` + `@@unique([senderId, clientMessageId])` |
| 增量同步 cursor | 已有 | HTTP `messages/sync` + WS `message:sync` |
| 接收方 delivery ack | 已有 | WS `message:delivered` |
| 用户送达游标 | 已有 | `MessageSyncState` |
| 客户端离线发送队列 | 未实现 | 需要前端配合 |
| 服务端补推/重试 | 未实现 | delivery ack 后可做 |

---

## 10. 本次落地内容

### 10.1 数据库

新增迁移：

```text
prisma/migrations/20260711000000_add_reliable_message_delivery/migration.sql
```

变更：

- `chat_messages.clientMessageId`
- 唯一索引：`chat_messages(senderId, clientMessageId)`
- 新表：`message_sync_states`
- 唯一索引：`message_sync_states(roomId, userId)`

### 10.2 后端代码

涉及文件：

```text
src/chat/dto/chat.dto.ts
src/chat/chat.service.ts
src/chat/chat.gateway.ts
src/chat/chat.controller.ts
```

新增/增强能力：

- 发送 DTO 支持 `clientMessageId`。
- `sendRoomMessage` 支持幂等发送。
- `sendPrivateMessage` 透传 `clientMessageId`。
- Gateway 遇到重复消息时只返回发送方 ack，不重复广播 `message:new`。
- 新增 HTTP 增量同步接口。
- 新增 WS `message:sync`。
- 新增 WS `message:delivered`。

### 10.3 新接口/事件

HTTP：

```http
GET /api/chat/rooms/:roomId/messages/sync?afterMessageId=msg1&take=100
```

WebSocket：

```text
message:sync
message:delivered
```

## 11. 遇到的问题与处理

### 11.1 幂等重试不能重复广播

问题：

客户端 ack 丢失后会用同一个 `clientMessageId` 重试。服务端如果只是返回已有消息但仍广播 `message:new`，接收方会收到重复实时事件。

处理：

`ChatService.sendRoomMessage` 返回内部结构：

```ts
{
  message,
  isDuplicate
}
```

Gateway 对外仍返回原来的 `message`，但当 `isDuplicate=true` 时不再广播 `message:new`。

### 11.2 Prisma Client 需要重新生成

问题：

新增 `clientMessageId` 和 `MessageSyncState` 后，旧 Prisma Client 没有这些类型。

处理：

执行：

```bash
pnpm prisma:generate
```

### 11.3 数据库必须同步迁移

问题：

如果只改代码和 Prisma schema，不执行迁移，运行时会再次出现类似 `column does not exist` 的错误。

处理：

执行：

```bash
pnpm exec prisma migrate deploy
```

并确认新迁移已应用。

---

## 12. 大型系统为什么还要继续增强

当前项目采用单端登录，且已经具备“落库不丢、发送幂等、重连补拉、用户级送达游标”。这对当前业务是够用的。

前端接入细节见 [frontend-reliable-message-integration.md](./frontend-reliable-message-integration.md)。

但大型 IM/协作系统通常还要继续建设下面几块。它们不是为了炫技，而是为了解决规模、弱网、跨端、审计和用户体验带来的真实问题。

### 12.1 前端本地离线发送队列

**为什么需要**

在真实移动网络里，用户点击发送时可能处于这些状态：

- App 显示在线，但 WebSocket 实际已经断开。
- 地铁、电梯、弱网环境下请求发不出去。
- 请求已经到服务端，但客户端没收到 ack。
- 用户连续发送多条消息，需要保持本地顺序。

如果没有本地队列，断网时点击发送会直接失败，用户体验很差；如果简单重试，又可能重复发送。

**解决方案**

客户端本地维护发送队列：

```text
pending -> sending -> sent
                \-> failed
```

每条本地消息生成稳定的 `clientMessageId`：

```json
{
  "clientMessageId": "uuid-from-client",
  "roomId": "room1",
  "content": "hello",
  "status": "pending"
}
```

发送规则：

- 用户点击发送后，先写入本地队列并立即渲染为 `pending`。
- 网络可用时发送到服务端。
- 服务端返回 `message.id` 后，本地消息从 `pending` 替换为服务端消息。
- 超时或断网时保留队列，恢复连接后用同一个 `clientMessageId` 重试。
- 服务端依靠 `senderId + clientMessageId` 保证幂等。

**当前项目状态**

服务端幂等已经做好；本地队列需要前端实现。

### 12.2 服务端补推/重试队列

**为什么需要**

当前服务端推送 `message:new` 后，如果客户端没有处理成功，服务端并不知道。客户端可以靠重连 `message:sync` 补拉，但大型系统通常还希望服务端主动提高送达率。

典型问题：

- WebSocket 推送时客户端刚好断线。
- Socket.IO 发送成功不等于业务消息被客户端落本地。
- 用户在线但 App 被系统挂起，消息事件没有被处理。
- 大促/高峰时瞬时推送失败，需要削峰重试。

**解决方案**

服务端维护“待投递任务”：

```text
消息落库
  -> 写待投递任务
  -> 推送 message:new
  -> 等待 message:delivered
  -> 收到 ack 后标记完成
  -> 超时未 ack 则重试或等待客户端 sync
```

可以用队列系统承载：

- Redis/Bull
- Kafka
- RabbitMQ
- 延迟队列

重试策略：

| 次数 | 延迟 |
|---|---|
| 第 1 次 | 立即 |
| 第 2 次 | 3 秒 |
| 第 3 次 | 10 秒 |
| 第 4 次 | 30 秒 |
| 后续 | 降级为离线补拉 |

注意事项：

- 重试必须依赖 `messageId` 幂等，客户端收到重复 `message:new` 要能去重。
- 不能无限重试，否则会拖垮队列。
- 对离线用户不必一直推，记录待同步即可。

**当前项目状态**

当前没有做服务端补推队列。现阶段依赖客户端重连后的 `message:sync` 补齐，复杂度更低。

### 12.3 逐条逐接收人的投递表

**为什么需要**

当前 `MessageSyncState` 是用户房间级游标：

```text
roomId + userId -> lastDeliveredId
```

它适合回答：

> 这个用户在这个房间大概同步到哪条消息？

但大型系统还要回答更细的问题：

- 群聊里某条消息送达了哪些人？
- 哪些人没收到，需要补推？
- 发送方能否看到“已送达 8 人，已读 3 人”？
- 审计时能否证明某条通知发给了某个用户？
- 某个用户的某条消息投递失败原因是什么？

这就需要逐条逐接收人的投递状态。

**解决方案**

新增 `MessageDelivery`：

```prisma
model MessageDelivery {
  id          String    @id @default(cuid())
  messageId   String
  userId      String
  deliveredAt DateTime?
  readAt      DateTime?
  failedAt    DateTime?
  failReason  String?

  @@unique([messageId, userId])
  @@index([userId, deliveredAt])
  @@map("message_deliveries")
}
```

消息发送后，为接收者生成 delivery 记录：

```text
私聊：1 条消息 -> 1 个接收人 delivery
小群：1 条消息 -> N 个成员 delivery
大群：不建议直接写全量，可用游标 + 懒生成
```

**代价**

逐接收人投递表会放大写入：

```text
100 人群聊发 1 条消息 = 1 条 message + 100 条 delivery
```

所以大型系统通常会按群规模分层：

| 场景 | 策略 |
|---|---|
| 私聊/小群 | 逐接收人 delivery |
| 中型群 | delivery + 批量写入 |
| 大群/直播群 | 用户游标 + 拉模式，不为每个成员写 delivery |

**当前项目状态**

当前只做了用户房间级 `MessageSyncState`，没有做逐条 `MessageDelivery`。对当前规模更轻、更容易维护。

### 12.4 精确已读到某条消息

**为什么需要**

当前项目用 `RoomMember.lastReadAt` 表示已读时间。这个方案简单，但有几个边界：

- 多条消息 `createdAt` 非常接近时，时间戳可能不够精确。
- 数据库时间和客户端时间不能混用。
- 用户需要显示“读到哪条消息”时，消息 ID 比时间更可靠。
- 撤回/删除/补写消息时，时间型已读可能产生歧义。

**解决方案**

把已读状态升级为消息游标：

```prisma
model RoomMember {
  ...
  lastReadAt        DateTime?
  lastReadMessageId String?
}
```

接口入参：

```json
{
  "lastReadMessageId": "msg999"
}
```

服务端校验：

- 消息存在。
- 消息属于该房间。
- 用户是房间成员。
- 新游标不能比旧游标倒退。

未读数计算可以改为：

```text
roomId 相同
senderId != 自己
isDeleted = false
createdAt > lastReadMessage.createdAt
```

必要时结合 `id` 做稳定排序。

**当前项目状态**

当前仍使用 `lastReadAt`。对普通聊天已够用；如果要做更精确的已读回执，可以升级为 `lastReadMessageId`。

### 12.5 多端同步

**为什么大型系统需要**

如果允许同一账号同时登录手机、Web、桌面端，就会出现：

- 手机收到消息，Web 也要补齐。
- 手机读了会话，Web 未读数也要清零。
- Web 发出的消息，手机也要看到自己发出的消息。
- 每个设备同步进度不同。

这时用户级游标不够，需要设备级游标：

```text
roomId + userId + deviceId -> lastDeliveredId
```

**当前项目状态**

当前项目是单端登录，不需要多端同步。不要为了面试概念提前引入 `deviceId`，否则会增加登录态、踢下线、游标合并、已读合并的复杂度。

### 12.6 消息顺序与全局序列号

**为什么需要**

大型系统中，多个服务实例同时写消息时，单靠 `createdAt` 排序可能有问题：

- 不同机器时间有微小偏差。
- 同一毫秒内有多条消息。
- 数据库写入顺序和业务展示顺序不一定完全一致。

**解决方案**

为每个房间维护递增序列：

```text
roomSeq: 1, 2, 3, 4...
```

消息表增加：

```prisma
roomSeq BigInt?

@@unique([roomId, roomSeq])
@@index([roomId, roomSeq])
```

客户端同步时用：

```http
GET /messages/sync?afterSeq=123
```

**当前项目状态**

当前用 `createdAt + id` 做排序，对当前规模可接受。后续如果要做更强顺序保证，再引入 `roomSeq`。

### 12.7 消息归档与冷热分层

**为什么需要**

大型系统消息量会非常大：

```text
100 万用户 * 每天 50 条消息 = 5000 万条/天
```

长期都放在主表里，会影响：

- 查询性能
- 索引体积
- 备份恢复
- 成本

**解决方案**

按时间或房间分区：

- 近 30 天热数据放主库。
- 更老消息归档到冷库/对象存储/搜索系统。
- 历史消息按时间段分页拉取。
- 搜索走专门索引。

**当前项目状态**

当前未做归档。项目规模没到时不需要提前做。

---

## 13. 面试回答模板

如果面试官问：“你们怎么保证离线消息不丢？”

可以按这条线回答：

```text
第一层，服务端不丢：
消息先落库，再推送；发送方只有拿到服务端 ack 才认为发送成功。

第二层，发送幂等：
客户端生成 clientMessageId，服务端按 senderId + clientMessageId 唯一约束。
ack 丢了客户端可以重试，但不会重复落库。

第三层，离线补拉：
客户端重连后按 afterMessageId/游标增量同步，补齐离线期间消息。

第四层，送达确认：
客户端收到消息后发 message:delivered，服务端记录用户在房间内的送达游标。

第五层，大型系统增强：
如果要更强保证，会加服务端补推队列、逐接收人 MessageDelivery、
精确 lastReadMessageId、房间序列号 roomSeq、冷热归档。
```

当前项目做到前四层，后面的增强已在文档中列为后续方案。

---

## 14. 对外口径

如果前端问“离线消息做好了吗”，建议这样回答：

> 目前服务端已经保证消息发送成功后会先落库，接收方离线不会导致消息丢失；发送方重试可通过 `clientMessageId` 幂等，接收方重连可通过 sync 接口补拉，收到后可用 `message:delivered` 确认。  
> 但客户端本地离线发送队列、服务端补推队列、多端投递状态还需要继续建设。
