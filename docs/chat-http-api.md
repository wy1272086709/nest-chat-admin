# Chat HTTP 接口文档（ChatController）

> 本文聚焦 [chat.controller.ts](../src/chat/chat.controller.ts) 提供的 **7 个 HTTP 接口**，给出可直接对接的完整契约（请求参数 / 响应体 / 错误码 / 实时事件副作用）。
>
> 聊天模块的整体架构、WebSocket 事件、数据模型请见 [chat-api.md](./chat-api.md)；鉴权流程见 [jwt-auth-flow.md](./jwt-auth-flow.md)。

---

## 1. 通用约定

### 1.1 基础信息

| 项 | 值 |
|---|---|
| 全局前缀 | `/api`（来自 `GLOBAL_PREFIX`，默认 `/api`） |
| 控制器前缀 | `/api/chat`（`@Controller('chat')`） |
| 鉴权 | 全局 `JwtAuthGuard`，请求头携带 `Authorization: Bearer <token>` |
| 当前用户 | `@CurrentUser() user: ChatUser`，从 JWT 解析，所有接口均依赖 `user.id` |
| 内容类型 | `application/json`（POST/GET body） |
| Swagger | 启动后见 `http://localhost:3000/docs`，分组 `Chat` |

### 1.2 响应格式（两条处理路径，字段统一用 `result`）

所有响应都以 `result` 字段表示成败。依异常是否被 Controller 捕获，走两条路径，差异在 `code` 取值与是否附带 `path`：

**① 成功** —— 经 `TransformInterceptor`，HTTP **恒为 200**：

```json
{
  "result": true,
  "code": 200,
  "data": { "...": "..." },
  "message": "描述"
}
```

**② 业务错误** —— Service 抛 `ForbiddenException` / `ConflictException` / `NotFoundException`，**被 Controller 方法体内的 `try/catch` 捕获**，仍经拦截器，HTTP **仍为 200**：

```json
{
  "result": false,
  "code": 200,
  "data": null,
  "message": "你不是该聊天的成员"
}
```

**③ 校验 / 鉴权 / 系统错误** —— 发生在 Controller 方法体**之外**（管道 / 守卫阶段或未捕获异常），冒泡到 `GlobalExceptionFilter`，HTTP 为真实状态码，并额外带 `path`：

```json
{
  "result": false,
  "code": 400,
  "data": null,
  "message": "name: 群聊名称不能为空",
  "path": "/api/chat/rooms/group"
}
```

| 错误来源 | 形态 | 典型 HTTP | 典型 `message` |
|---|---|---|---|
| DTO 校验失败（`ValidationPipe`） | ③ | 400 | `name: 群聊名称不能为空` |
| 未登录 / token 失效（`JwtAuthGuard`） | ③ | 401 | `Token 已过期，请重新登录` |
| 非房间成员等（Service 抛 `ForbiddenException` 等） | ② | **200** | `你不是该聊天的成员` |

> ⚠️ **对接提示**：判断成败统一看 `result` 字段即可。需注意 `code` 的语义差异：业务错误（形态②）因 Controller `try/catch` + 拦截器强制 `status(200)`，`code` 恒为 200、HTTP 状态码也恒为 200，不可靠；校验 / 鉴权 / 系统错误（形态③）的 `code` 是真实 4xx/5xx，且响应会多带一个 `path` 字段。

### 1.3 请求校验

全局 `ValidationPipe`（[app.module.ts](../src/app.module.ts)）配置：

- `whitelist: true` —— 自动剥离 DTO 未定义的多余字段；
- `forbidNonWhitelisted: true` —— 传多余字段直接报错（形态③，400）；
- `transform: true` —— 自动类型转换，故 `?take=50` 字符串会转为 `number`；
- 自定义 `exceptionFactory` —— 校验错误信息形如 `"<字段名>: <第一条规则提示>"`（如 `take: 分页大小必须是整数`）。

### 1.4 鉴权与「当前用户」

- `JwtAuthGuard` 校验 `Authorization` 头中的 JWT，解析出 `ChatUser` 注入到 `@CurrentUser()`。
- 接口内部不再二次校验登录态；涉及房间权限的接口由 `ChatService.assertRoomMember(roomId, userId)` 保证调用者是该房间的 `ACTIVE` 成员，否则抛 `ForbiddenException('你不是该聊天的成员')`。

---

## 2. 接口一览

| # | 方法 | 路径 | 说明 | 实时事件副作用 |
|---|---|---|---|---|
| 3.1 | POST | `/api/chat/rooms/group` | 创建群聊房间 | 向所有成员推 `room:created` |
| 3.2 | POST | `/api/chat/rooms/private` | 发起 / 获取私聊会话 | 向双方推 `room:private` |
| 3.3 | GET | `/api/chat/rooms` | 当前用户的会话列表 | 无 |
| 3.4 | GET | `/api/chat/rooms/:roomId/messages` | 分页历史消息 | 无 |
| 3.5 | GET | `/api/chat/rooms/:roomId/members` | 房间成员列表 | 无 |
| 3.6 | POST | `/api/chat/rooms/:roomId/read` | 标记房间已读 | 向房间推 `room:read` |
| 3.7 | POST | `/api/chat/rooms/:roomId/clear` | 清空本人聊天记录（软清空） | 无 |

> 「实时事件副作用」指 Controller 内部调用 `ChatGateway` 的推送方法（[chat.gateway.ts](../src/chat/chat.gateway.ts) `emitToUsers` / `emitToRoom`），让走 HTTP 的操作也能同步到在线 WebSocket 客户端。

---

## 3. 接口详情

### 3.1 创建群聊

`POST /api/chat/rooms/group` · [controller](../src/chat/chat.controller.ts) · [service: createGroupRoom](../src/chat/chat.service.ts)

**请求体** `CreateGroupRoomDto`：

| 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| `name` | string | ✅ | 非空字符串 | 群聊名称 |
| `description` | string | ❌ | — | 群聊描述 |
| `memberIds` | string[] | ❌ | 字符串数组 | 初始成员用户 ID（创建者自动加入并成为 `OWNER`，无需重复传入） |

**成功响应** `data`：`ChatRoom & { members: RoomMember[] }`

```jsonc
{
  "result": true, "code": 200, "message": "群聊创建成功",
  "data": {
    "id": "clxxxxx",
    "name": "技术交流群",
    "description": "可选",
    "topic": null,                 // ChatRoom.topic，非会话类型；会话类型看下文 topic 说明
    "maxMembers": null,
    "createdBy": "userA",
    "ownerId": "userA",
    "isArchived": false,
    "createdAt": "2026-06-26T10:00:00.000Z",
    "updatedAt": "2026-06-26T10:00:00.000Z",
    "members": [
      { "id": "m1", "roomId": "clxxxxx", "userId": "userA", "role": "OWNER",  "status": "ACTIVE", "joinedAt": "...", "lastReadAt": null },
      { "id": "m2", "roomId": "clxxxxx", "userId": "userB", "role": "MEMBER", "status": "ACTIVE", "joinedAt": "...", "lastReadAt": null }
    ]
  }
}
```

> 注：`createGroupRoom` 的 `topic` 字段（`ChatRoom` 上的列）**不会被设置**，仅会话类型在 `listConversations` 中以 `room.topic` 暴露。区分群/私聊应看 `ChatRoom` 的业务标识（建群时为群、私聊房间名为 `sorted(uidA:uidB)`）。

**实时事件**：`room:created`，payload 为完整的 `room`，推送给 `members[].userId` 全员。

**错误**：DTO 校验失败 → 形态③（400）。

---

### 3.2 发起 / 获取私聊会话

`POST /api/chat/rooms/private` · [controller](../src/chat/chat.controller.ts) · [service: getOrCreatePrivateRoom](../src/chat/chat.service.ts)

> 仅「建联」——创建或复用已有私聊房间，**不发消息**。

**请求体** `InitPrivateRoomDto`：

| 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| `receiverId` | string | ✅ | 非空字符串 | 对方用户 ID |

**成功响应** `data`：`ChatRoom & { members: RoomMember[] }`（已存在则返回既有房间，幂等）。

**实时事件**：`room:private`，payload 为 `room`，推送给双方成员。

**业务错误**（形态②，HTTP 200）：

| 触发条件 | `message` |
|---|---|
| `receiverId` 等于自己 | `不能给自己发送私聊消息`（Conflict） |
| `receiverId` 对应用户不存在 | `接收者不存在`（NotFound） |

---

### 3.3 会话列表

`GET /api/chat/rooms` · [controller](../src/chat/chat.controller.ts) · [service: listConversations](../src/chat/chat.service.ts)

返回当前用户所有 `ACTIVE` 会话（群聊 + 私聊），按房间 `updatedAt desc` 排序，每条含**最后一条消息**与**未读数**。

**请求参数**：无。

**成功响应** `data`：`Conversation[]`

```jsonc
{
  "result": true, "code": 200, "message": "会话列表获取成功",
  "data": [
    {
      "room": {
        "id": "room1", "name": "...", "topic": "GROUP",
        "members": [{ "userId": "...", "user": { "id": "...", "username": "...", "nickname": "...", "avatarUrl": null } }]
      },
      "role": "MEMBER",
      "lastReadAt": "2026-06-26T10:00:00.000Z",
      "clearedAt": null,
      "lastMessage": {
        "id": "msg1", "content": "在吗", "messageType": "TEXT",
        "senderId": "userB", "createdAt": "...",
        "sender": { "id": "userB", "username": "...", "nickname": "...", "avatarUrl": null }
      },
      "unreadCount": 3
    }
  ]
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `room` | 房间信息（含 `members[].user` 简要资料） |
| `role` | 当前用户在该房间的角色（`OWNER` / `MEMBER`） |
| `lastReadAt` | 当前用户在该房间的最后已读时间，未读时为 `null` |
| `clearedAt` | 当前用户在该房间的清空时间点，未清空为 `null` |
| `lastMessage` | 晚于 `clearedAt` 的最近一条未删除消息，无则为 `null` |
| `unreadCount` | 未读数：房间内 `senderId != 自己`、未删除，且 `createdAt > max(lastReadAt, clearedAt)` 的消息数 |

**实时事件**：无。

---

### 3.4 历史消息

`GET /api/chat/rooms/:roomId/messages` · [controller](../src/chat/chat.controller.ts) · [service: getMessages](../src/chat/chat.service.ts)

**请求参数**：

| 位置 | 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|---|
| path | `roomId` | string | ✅ | — | 房间 ID |
| query | `take` | number | ❌ | 整数，1~100 | 条数，默认 50 |

**返回顺序**：`createdAt desc`（新的在前），并自动过滤 `isDeleted=false` 且晚于 `clearedAt` 的消息。

**成功响应** `data`：`Message[]`（含 `sender`）

```jsonc
{
  "result": true, "code": 200, "message": "历史消息获取成功",
  "data": [
    {
      "id": "msg1", "roomId": "room1", "senderId": "userB",
      "content": "在吗", "messageType": "TEXT",
      "fileUrl": null, "fileName": null, "fileSize": null, "fileType": null,
      "thumbnailUrl": null, "mediaWidth": null, "mediaHeight": null, "duration": null,
      "isEdited": false, "editedAt": null, "isDeleted": false, "deletedAt": null,
      "createdAt": "2026-06-26T10:00:00.000Z",
      "sender": { "id": "userB", "username": "b", "nickname": "小B", "avatarUrl": null }
    }
  ]
}
```

**业务错误**（形态②）：非该房间 `ACTIVE` 成员 → `你不是该聊天的成员`。

---

### 3.5 成员列表

`GET /api/chat/rooms/:roomId/members` · [controller](../src/chat/chat.controller.ts) · [service: getRoomMembers](../src/chat/chat.service.ts)

**请求参数**：

| 位置 | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| path | `roomId` | string | ✅ | 房间 ID |

**返回顺序**：`joinedAt asc`（按入群时间正序）。

**成功响应** `data`：`RoomMember[]`（含 `user`）

```jsonc
{
  "result": true, "code": 200, "message": "成员列表获取成功",
  "data": [
    {
      "id": "m1", "roomId": "room1", "userId": "userA",
      "role": "OWNER", "status": "ACTIVE",
      "joinedAt": "2026-06-26T09:00:00.000Z", "lastReadAt": "2026-06-26T10:00:00.000Z",
      "user": { "id": "userA", "username": "a", "nickname": "小A", "avatarUrl": null }
    }
  ]
}
```

**业务错误**（形态②）：非该房间 `ACTIVE` 成员 → `你不是该聊天的成员`。

---

### 3.6 标记已读

`POST /api/chat/rooms/:roomId/read` · [controller](../src/chat/chat.controller.ts) · [service: markRoomRead](../src/chat/chat.service.ts)

更新当前用户在该房间的 `lastReadAt = now`。

**请求参数**：

| 位置 | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| path | `roomId` | string | ✅ | 房间 ID |

**成功响应** `data`：更新后的 `RoomMember`（**不含** `user` 嵌套）

```jsonc
{
  "result": true, "code": 200, "message": "已读设置成功",
  "data": {
    "id": "m1", "roomId": "room1", "userId": "userA",
    "role": "OWNER", "status": "ACTIVE",
    "joinedAt": "2026-06-26T09:00:00.000Z",
    "lastReadAt": "2026-06-26T10:00:01.234Z"
  }
}
```

**实时事件**：`room:read`，向房间内在线成员推送 `{ roomId, userId, lastReadAt }`（便于对方渲染「已读」状态）。

**业务错误**（形态②）：非该房间 `ACTIVE` 成员 → `你不是该聊天的成员`。

---

### 3.7 清空聊天

`POST /api/chat/rooms/:roomId/clear` · [controller](../src/chat/chat.controller.ts) · [service: clearRoom](../src/chat/chat.service.ts)

> **软清空**：写 `ChatClearState.clearedAt = now`，仅对**当前用户**隐藏该时间点之前的历史，**不删除原消息**，其他成员与未读统计不受影响（再次 `getMessages` / `listConversations` 时会据此过滤）。

**请求参数**：

| 位置 | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| path | `roomId` | string | ✅ | 房间 ID |

**成功响应** `data`：`ChatClearState`

```jsonc
{
  "result": true, "code": 200, "message": "聊天记录已清空",
  "data": { "id": "cs1", "roomId": "room1", "userId": "userA", "clearedAt": "2026-06-26T10:00:00.000Z" }
}
```

**实时事件**：无（清空为纯本地视图，不广播）。

**业务错误**（形态②）：非该房间 `ACTIVE` 成员 → `你不是该聊天的成员`。

---

## 4. 数据结构速查

| 模型 | 关键字段 |
|---|---|
| `ChatRoom` | `id`, `name`, `description?`, `topic?`, `maxMembers?`, `createdBy`, `ownerId`, `isArchived`, `createdAt`, `updatedAt` |
| `RoomMember` | `id`, `roomId`, `userId`, `joinedAt`, `role`(OWNER\|MEMBER), `status`(ACTIVE\|…), `lastReadAt?` |
| `Message` | `id`, `roomId`, `senderId`, `content?`, `messageType`(TEXT\|IMAGE\|FILE\|AUDIO\|VIDEO), `fileUrl?`, `fileName?`, `fileSize?`, `fileType?`, `thumbnailUrl?`, `mediaWidth?`, `mediaHeight?`, `duration?`, `isEdited`, `editedAt?`, `isDeleted`, `deletedAt?`, `createdAt` |
| `ChatClearState` | `id`, `roomId`, `userId`, `clearedAt` |
| 用户简要资料（`sender` / `user`） | `id`, `username`, `nickname`, `avatarUrl?` |

> 注：私聊房间的 `name` 为两端用户 ID 排序后用 `:` 拼接（如 `userA:userB`），以此保证同一对用户私聊房间唯一（见 [getPrivateRoomName](../src/chat/chat.service.ts)）。

---

## 5. curl 速查

```bash
TOKEN="Bearer <your-jwt>"
BASE="http://localhost:3000/api/chat"

# 3.1 创建群聊
curl -X POST "$BASE/rooms/group" -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"技术交流群","description":"可选","memberIds":["userB","userC"]}'

# 3.2 发起私聊会话
curl -X POST "$BASE/rooms/private" -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"receiverId":"userB"}'

# 3.3 会话列表
curl "$BASE/rooms" -H "Authorization: $TOKEN"

# 3.4 历史消息（取最近 20 条）
curl "$BASE/rooms/room1/messages?take=20" -H "Authorization: $TOKEN"

# 3.5 成员列表
curl "$BASE/rooms/room1/members" -H "Authorization: $TOKEN"

# 3.6 标记已读
curl -X POST "$BASE/rooms/room1/read" -H "Authorization: $TOKEN"

# 3.7 清空聊天（仅对当前用户隐藏）
curl -X POST "$BASE/rooms/room1/clear" -H "Authorization: $TOKEN"
```

---

## 附：实现备忘（写给维护者）

- **Controller 与 Gateway 分工**：Controller 负责「请求-响应」型操作（会话/历史/成员/已读/清空/HTTP 建群私聊），消息收发与实时推送在 [ChatGateway](../src/chat/chat.gateway.ts)；二者共用同一 [ChatService](../src/chat/chat.service.ts)，不重复业务逻辑。
- **响应格式现状**：所有响应统一用 `result` 表示成败。两条路径差异在于：成功与业务错误（Controller `try/catch` 兜底）经 `TransformInterceptor`，`code` 恒 200、无 `path`；校验/鉴权/系统错误经 `GlobalExceptionFilter`，`code` 为真实 4xx/5xx、带 `path`。详见 1.2 节。
- **未读数实现**：`listConversations` 对每个会话单独查未读数（会话量不大时的简单实现），注释中标注后续可改为一次 `groupBy` 批量聚合。
