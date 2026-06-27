# Chat 聊天接口文档

涵盖**群聊 / 私聊**，支持**文本 / 图片 / 文件 / 音视频**消息，含**已读、清空**能力。

## 1. 架构总览

聊天由两个入口组成，共用同一个 `ChatService`，不重复业务逻辑：

```
                ┌─────────────────────────────┐
   HTTP 客户端 ──▶│  ChatController  (/api/chat) │──┐
                └─────────────────────────────┘  │
                                                  ├─▶ ChatService ──▶ Prisma(存表)
                ┌─────────────────────────────┐  │                       │
  WebSocket 客户 ─▶│  ChatGateway  (ws /chat)     │──┘                       ▼
                └─────────────────────────────┘               server.to(room).emit(实时推送)
```

| 入口 | 职责 |
|---|---|
| **HTTP Controller** `/api/chat` | 会话列表、历史消息、成员、已读、清空等"请求-响应"查询；HTTP 建群 / 发起私聊 |
| **WebSocket Gateway** `/chat` | 消息收发 + 实时推送（在线即时同步） |

> HTTP 的建群 / 已读操作内部也会调用 Gateway 推送，保证**走 HTTP 的操作也能实时同步**到在线客户端。

## 2. 鉴权

- **HTTP**：全局 `JwtAuthGuard`，请求头带 `Authorization: Bearer <token>`。
- **WebSocket**：连接 `/chat` 命名空间时通过握手传 token：
  - `socket.handshake.auth.token`（推荐），或
  - `socket.handshake.headers.authorization = "Bearer <token>"`

  连接成功 → 服务端发 `chat:connected`；失败 → 发 `chat:error` 并断开。

## 3. 统一响应格式（HTTP）

所有 HTTP 响应经 `TransformInterceptor` 包装为：

```json
{
  "result": true,
  "code": 200,
  "message": "描述",
  "data": { ... }
}
```

失败时 `result: false`、`data: null`、`message` 为错误信息。

## 4. 消息类型与必填字段

`MessageType` 枚举：`TEXT | IMAGE | FILE | AUDIO | VIDEO`。

| 类型 | messageType | 必填 | 可选（媒体） |
|---|---|---|---|
| 文本 | `TEXT` 或不传 | `content` | — |
| 图片 | `IMAGE` | `fileUrl` | `fileName` `fileSize` `fileType` `thumbnailUrl` `mediaWidth` `mediaHeight` |
| 文件 | `FILE` | `fileUrl` | `fileName` `fileSize` `fileType` `thumbnailUrl` |
| 语音 | `AUDIO` | `fileUrl` | `fileName` `fileSize` `duration` |
| 视频 | `VIDEO` | `fileUrl` | `fileName` `fileSize` `thumbnailUrl` `mediaWidth` `mediaHeight` `duration` |

> 由 DTO 的 `@ValidateIf` 按类型动态校验，避免出现"空文本"或"无地址的图片"。

## 5. HTTP 接口

> 每个接口的完整契约（请求参数 / 响应体 / 错误码 / curl / 实时事件副作用）见 [chat-http-api.md](./chat-http-api.md)，本节仅作概览。

全局前缀 `/api`。

### 5.1 创建群聊

`POST /api/chat/rooms/group`

```json
// body
{
  "name": "技术交流群",
  "description": "可选",
  "memberIds": ["userB", "userC"]
}
```

实时事件：向所有成员推送 `room:created`。

### 5.2 发起 / 获取私聊会话

`POST /api/chat/rooms/private`

```json
{ "receiverId": "userB" }
```

> 仅建联（创建或复用已有私聊房间），不发消息。实时事件：向双方推送 `room:private`。

### 5.3 会话列表

`GET /api/chat/rooms`

返回当前用户的所有会话（群聊 + 私聊），每条含最后一条消息与未读数：

```json
{
  "result": true, "code": 200, "message": "会话列表获取成功",
  "data": [
    {
      "room": { "id": "room1", "name": "...", "topic": "GROUP" },
      "role": "MEMBER",
      "lastReadAt": "2026-06-26T10:00:00.000Z",
      "clearedAt": null,
      "lastMessage": { "id": "msg1", "content": "在吗", "messageType": "TEXT", "sender": { ... } },
      "unreadCount": 3
    }
  ]
}
```

### 5.4 历史消息

`GET /api/chat/rooms/:roomId/messages?take=50`

- `take`：条数，1~100，默认 50；按 `createdAt desc` 返回。
- 自动过滤**已清空**的消息（仅返回晚于 `clearedAt` 的）。

### 5.5 成员列表

`GET /api/chat/rooms/:roomId/members`

### 5.6 标记已读

`POST /api/chat/rooms/:roomId/read`

更新该用户在该房间的 `lastReadAt`。实时事件：向房间推送 `room:read`。

### 5.7 清空聊天

`POST /api/chat/rooms/:roomId/clear`

> **软清空**：只对当前用户隐藏历史（写 `ChatClearState`），**不删除原消息**，其他成员不受影响。

### curl 示例

```bash
# 发起私聊会话
curl -X POST http://localhost:3000/api/chat/rooms/private \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"receiverId":"userB"}'

# 历史消息
curl "http://localhost:3000/api/chat/rooms/room1/messages?take=20" \
  -H "Authorization: Bearer <token>"
```

## 6. WebSocket 接口

命名空间：`/chat`。

### 6.1 客户端 → 服务端

| 事件 | 入参 | 说明 |
|---|---|---|
| `room:join` | `{ roomId }` | 加入房间（校验成员身份） |
| `room:createGroup` | `{ name, description?, memberIds? }` | 建群 |
| `message:sendRoom` | `{ roomId, content?, messageType?, fileUrl?, ... }` | 发群消息 |
| `message:sendPrivate` | `{ receiverId, content?, messageType?, fileUrl?, ... }` | 发私聊消息 |
| `message:list` | `{ roomId, take? }` | 拉历史 |
| `room:read` | `{ roomId }` | 标记已读 |
| `room:clear` | `{ roomId }` | 清空 |

### 6.2 服务端 → 客户端

| 事件 | 数据 | 说明 |
|---|---|---|
| `chat:connected` | `{ userId }` | 连接认证成功 |
| `chat:error` | `{ message }` | 认证失败 / 异常 |
| `room:joined` | `{ roomId }` | 加入房间成功 |
| `room:created` | room | 新群创建（通知所有成员） |
| `room:private` | room | 私聊会话创建/复用（通知双方） |
| `message:new` | message | **新消息到达**（核心实时事件） |
| `message:sent` | message / `{ room, message }` | 发送成功回执（发给发送者） |
| `message:list` | message[] | 历史消息 |
| `room:read` | `{ roomId, userId, lastReadAt }` | 某用户已读（通知房间） |
| `room:cleared` | clearState | 清空成功 |

### 6.3 客户端示例（socket.io）

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/chat', {
  auth: { token: '<jwt>' },
});

socket.on('connect', () => console.log('connected', socket.id));
socket.on('chat:connected', (d) => console.log('auth ok', d));
socket.on('chat:error', (e) => console.error(e));
socket.on('message:new', (msg) => console.log('收到消息', msg));

// 发私聊文本
socket.emit('message:sendPrivate', { receiverId: 'userB', content: '在吗' });

// 发图片（需先上传拿到 fileUrl）
socket.emit('message:sendPrivate', {
  receiverId: 'userB',
  messageType: 'IMAGE',
  fileUrl: 'https://cdn/x.png',
  mediaWidth: 1080,
  mediaHeight: 1920,
});

// 标记已读
socket.emit('room:read', { roomId: 'room1' });
```

## 7. 典型流程：发送一条私聊消息

```
客户端A                  服务端                   客户端B(在线)
  │  message:sendPrivate  │                          │
  │──────────────────────▶│ 存表(Message)            │
  │                       │                          │
  │  message:sent(回执)   │  message:new + room:private│
  │◀──────────────────────│─────────────────────────▶│
```

1. 客户端 A emit `message:sendPrivate`。
2. `ChatService` 取/建私聊房间 → `message.create` 落库。
3. A 收到 `message:sent` 回执；A、B 各收到 `message:new`（实时同步）。

## 8. 数据模型（关键字段）

```
ChatRoom    id, name, topic(GROUP|PRIVATE), createdBy, ownerId
RoomMember  roomId, userId, role(OWNER|MEMBER), status, lastReadAt   ← 已读依据
Message     id, roomId, senderId, content, messageType,
            fileUrl, fileName, fileSize, fileType,
            thumbnailUrl, mediaWidth, mediaHeight, duration,         ← 媒体扩展
            isDeleted(软删除), createdAt
ChatClearState roomId, userId, clearedAt                              ← 清空依据
```

**未读数计算**：某房间内 `senderId != 自己`、未删除、且 `createdAt > max(lastReadAt, clearedAt)` 的消息数。

## 9. 启用前必做

Prisma client 需按最新 schema 重新生成，媒体字段需落库：

```bash
cd nest-admin
npx prisma generate                          # 生成 client（修复类型报错）
npx prisma migrate dev --name chat_message_media   # 落地 4 个新媒体字段
```

启动后访问 Swagger：`http://localhost:3000/docs`（`Chat` 分组）。
