# User HTTP 接口文档（好友 / 社交域）

> 本文按**业务域**组织，聚焦「好友 / 社交」相关接口，覆盖好友关系的完整生命周期：**发起申请 → 处理申请 → 好友列表 → 群聊列表**。
>
> 这些接口分属**两个控制器**：发起申请、好友 / 群聊列表在 [user.controller.ts](../src/user/controllers/user.controller.ts)（`/api/users`）；处理好友申请在 [notification.controller.ts](../src/notification/notification.controller.ts)（`/api/notifications`），后者的处理逻辑（同意时建立好友关系）也归在本页，便于一处看完整个好友流程。
>
> 响应格式（`TransformInterceptor` / `GlobalExceptionFilter`、`result` 字段、HTTP 状态码语义）见 [chat-http-api.md §1.2](./chat-http-api.md)，本文不再重复；鉴权流程见 [jwt-auth-flow.md](./jwt-auth-flow.md)。

---

## 1. 通用约定

| 项 | 值 |
|---|---|
| 全局前缀 | `/api` |
| 控制器前缀 | 因接口而异：好友申请 / 好友列表 / 群聊列表在 `/api/users`，处理好友申请在 `/api/notifications`（详见各接口） |
| 鉴权 | 全局 `JwtAuthGuard`，请求头携带 `Authorization: Bearer <token>`；用户身份由 `@CurrentUser() user: ChatUser` 注入 |
| 响应包装 | 成功与业务错误（Controller 方法体内 `try/catch` 兜底）经 `TransformInterceptor`，为 `{ result, code:200, data, message }`，HTTP 恒 200 |

> ⚠️ **对接提示**：下列接口的业务错误（如「你们已经是好友了」「好友申请不存在」）均被各自 Controller 的 `try/catch` 捕获，**HTTP 恒 200、`code` 恒 200**，**成败只看 `result` 字段**。这与 [chat-http-api.md §1.2](./chat-http-api.md) 形态②一致；DTO 校验 / 鉴权失败才会冒泡到 `GlobalExceptionFilter`（形态③，真实 4xx）。

## 2. 接口一览

| # | 方法 | 路径 | 控制器 | 说明 |
|---|---|---|---|---|
| 3.1 | POST | `/api/users/addFriend` | UserController | 发起好友申请（创建一条 `FRIEND_REQUEST` 通知） |
| 3.2 | POST | `/api/notifications/handleFriendRequest` | NotificationController | 同意 / 拒绝好友申请（同意则建立好友关系） |
| 3.3 | GET | `/api/users/friends` | UserController | 当前用户的好友列表（对方用户资料） |
| 3.4 | GET | `/api/users/groups` | UserController | 当前用户加入的群聊列表（含角色与成员数，排除私聊） |

---

## 3. 接口详情

### 3.1 添加好友（发起申请）

`POST /api/users/addFriend` · [controller: addFriend](../src/user/controllers/user.controller.ts) · [service: addFriend](../src/user/services/user.service.ts)

向 `receiverId` 发起好友申请：创建一条 `type=FRIEND_REQUEST`、`result=PENDING` 的通知（`targetId=receiverId`，`extra.message` 存打招呼语），等待对方通过 [3.2 处理好友请求](#32-处理好友请求同意--拒绝) 处理。**本接口只建通知，不直接建好友关系，也不建私聊房间。**

**请求体** `AddFriendDto`：

| 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| `receiverId` | string | ✅ | 非空字符串 | 接收好友申请的用户 ID |
| `message` | string | ❌ | — | 好友申请备注（打招呼语），存入通知 `extra.message` |

**成功响应**：`data` 恒为 `null`

```jsonc
{
  "result": true, "code": 200, "message": "好友申请已发送", "data": null
}
```

**业务错误**（形态②，HTTP 200，`result:false`）：

| 触发条件 | `message` | Service 抛出 |
|---|---|---|
| `receiverId` 等于自己 | `不能添加自己为好友` | `HttpException(400)` |
| `receiverId` 对应用户不存在 | `用户不存在` | `NotFoundException(404)` |
| 双方已是好友（`ChatFriendship` 存在） | `你们已经是好友了` | `ConflictException(409)` |
| 双向已有 `PENDING` 的 `FRIEND_REQUEST` | `已有待处理的好友申请` | `ConflictException(409)` |

> 注：申请去重是**双向**的——任一方发起且该通知仍 `PENDING` 时，另一方再发也会被拦截，避免产生重复通知。好友关系判定按双方用户 ID 排序后的 `userAId` / `userBId` 唯一存储（见 [getFriendshipPair](../src/user/services/user.service.ts)）。

---

### 3.2 处理好友请求（同意 / 拒绝）

`POST /api/notifications/handleFriendRequest` · [controller: handleFriendRequest](../src/notification/notification.controller.ts) · [service: handleFriendRequest](../src/notification/notification.service.ts)

> ⚠️ 该接口**位于 NotificationController（`/api/notifications`）**，不在 `/api/users`；只因与 [3.1](#31-添加好友发起申请) 同属好友流程而收录本页。

处理发给当前用户的好友申请通知：

- `REJECTED`：仅把通知 `result` 置为 `REJECTED`、`isRead=true`；
- `ACCEPTED`：在事务内创建 `ChatFriendship`（双方排序后 `userAId` / `userBId`，已存在则跳过），并把通知 `result` 置为 `ACCEPTED`、`isRead=true`。

**请求体** `HandleFriendRequestDto`：

| 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| `notificationId` | string | ✅ | 非空字符串 | 好友申请通知 ID（由 [3.1](#31-添加好友发起申请) 产生） |
| `action` | enum | ✅ | `ACCEPTED` \| `REJECTED` | 处理动作 |

**成功响应** `data`：更新后的通知（`Notification` 裸记录，**不含** `sender` 嵌套）

```jsonc
{
  "result": true, "code": 200, "message": "好友申请处理成功",
  "data": {
    "id": "noti1",
    "type": "FRIEND_REQUEST",
    "isRead": true,
    "result": "ACCEPTED",            // REJECTED 时为 "REJECTED"
    "targetId": "userB",             // 即 receiverId
    "extra": { "message": "你好" },  // 发起方填的打招呼语，可能为 null
    "receiverId": "userB",
    "senderId": "userA",
    "createdAt": "2026-06-26T09:00:00.000Z",
    "updatedAt": "2026-06-26T10:00:00.000Z"
  }
}
```

**业务错误**（形态②，HTTP 200，`result:false`）：

| 触发条件 | `message` | Service 抛出 |
|---|---|---|
| 通知不存在或非 `FRIEND_REQUEST` | `好友申请不存在` | `NotFoundException(404)` |
| 该申请不是发给自己的（`receiverId != 自己`） | `只能处理发送给自己的好友申请` | `HttpException(403)` |
| 申请已处理（`result != PENDING`） | `该好友申请已处理` | `ConflictException(409)` |

> 注：同意好友后**不会**自动创建私聊房间，好友关系是单向建立的；私聊会话由 chat 模块的 `POST /api/chat/rooms/private` 按需建联（见 [chat-http-api.md §3.2](./chat-http-api.md)）。若需查询待处理的好友申请列表，用 `GET /api/notifications/friendRequests`。

---

### 3.3 获取好友列表

`GET /api/users/friends` · [controller: getFriends](../src/user/controllers/user.controller.ts) · [service: getFriends](../src/user/services/user.service.ts)

返回当前用户的所有好友。好友关系以 `ChatFriendship` 存储（`userAId` / `userBId` 为排序后的用户对），返回时取**对方**的用户资料。

**请求参数**：无。

**成功响应** `data`：对方用户数组（`ChatUser` 去掉 `passwordHash`）

```jsonc
{
  "result": true, "code": 200, "message": "好友列表获取成功",
  "data": [
    {
      "id": "userB",
      "username": "b",
      "email": "b@example.com",
      "nickname": "小B",
      "avatarUrl": null,
      "bio": null,
      "lastLoginAt": "2026-06-26T09:00:00.000Z",
      "status": "ACTIVE",
      "createdAt": "2026-06-01T00:00:00.000Z",
      "updatedAt": "2026-06-26T09:00:00.000Z"
    }
  ]
}
```

> 注：返回元素**不含** `passwordHash`；数组按好友关系建立时间 `createdAt desc` 排序。

---

### 3.4 获取群聊列表

`GET /api/users/groups` · [controller: getGroups](../src/user/controllers/user.controller.ts) · [service: getGroups](../src/user/services/user.service.ts)

返回当前用户加入的群聊：

- 只取 `status=ACTIVE` 的成员关系；
- **排除私聊**（`room.topic = 'PRIVATE'` 的房间，私聊由 chat 会话列表覆盖）；
- 每个群附带当前用户在该群的 `role` 与 `memberCount`（仅计 ACTIVE 成员）；
- 按 `room.updatedAt desc` 排序。

**请求参数**：无。

**成功响应** `data`：群聊数组

```jsonc
{
  "result": true, "code": 200, "message": "群聊列表获取成功",
  "data": [
    {
      "id": "clxxx",
      "name": "技术交流群",
      "description": "可选",
      "topic": null,
      "ownerId": "userA",
      "isArchived": false,
      "createdAt": "2026-06-10T00:00:00.000Z",
      "updatedAt": "2026-06-26T10:00:00.000Z",
      "role": "MEMBER",        // 当前用户在该群的角色（OWNER | MEMBER）
      "joinedAt": "2026-06-10T00:00:00.000Z",
      "memberCount": 12        // 群内 ACTIVE 成员数
    }
  ]
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `id` / `name` / `description` / `topic` | 群房间基本信息（`topic` 为群主题，非会话类型标识） |
| `ownerId` | 群主用户 ID |
| `isArchived` | 是否已归档 |
| `createdAt` / `updatedAt` | 房间创建 / 最近更新时间 |
| `role` | 当前用户在该群的角色：`OWNER`（群主）/ `MEMBER`（普通成员） |
| `joinedAt` | 当前用户加入该群的时间 |
| `memberCount` | 群内 `ACTIVE` 成员数 |

---

## 4. curl 速查

```bash
TOKEN="Bearer <your-jwt>"
USERS="http://localhost:3000/api/users"
NOTIFS="http://localhost:3000/api/notifications"

# 3.1 添加好友（发起申请）
curl -X POST "$USERS/addFriend" -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"receiverId":"userB","message":"你好，我是小A"}'

# 3.2 处理好友请求（同意 / 拒绝）
curl -X POST "$NOTIFS/handleFriendRequest" -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"notificationId":"noti1","action":"ACCEPTED"}'   # 或 "REJECTED"

# 3.3 好友列表
curl "$USERS/friends" -H "Authorization: $TOKEN"

# 3.4 群聊列表
curl "$USERS/groups" -H "Authorization: $TOKEN"
```

---

## 5. 实现备忘（写给维护者）

- **好友关系为何拆在两个控制器**：发起申请（`/api/users/addFriend`）属 user 资源，而「处理申请」本质是对一条通知的状态推进，且通知模块还承载群邀请等通用场景，故落在 NotificationController（`/api/notifications/handleFriendRequest`）。二者通过 `FRIEND_REQUEST` 类型的 `Notification` 串联，本页按业务域合并描述。
- **好友关系存储**：`ChatFriendship` 以双方用户 ID 排序后（`userAId < userBId`）唯一存储，`user.service` 与 `notification.service` 各有一份 `getFriendshipPair` 保证两端排序一致。
- **幂等性**：同意申请时若 `ChatFriendship` 已存在则跳过（事务内查后建），重复同意会被「该好友申请已处理」拦截。
