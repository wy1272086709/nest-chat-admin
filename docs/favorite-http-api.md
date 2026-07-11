# Favorite HTTP 接口文档（收藏）

> 本文聚焦 [favorite.controller.ts](../src/favorite/favorite.controller.ts) 提供的收藏接口，覆盖：**收藏列表、添加收藏、取消收藏**。
>
> 收藏后端会校验目标是否存在、当前用户是否有权限访问目标所在房间，以及收藏类型是否与消息类型匹配。

---

## 1. 通用约定

| 项 | 值 |
|---|---|
| 全局前缀 | `/api` |
| 控制器前缀 | `/api/favorites` |
| 鉴权 | 全局 `JwtAuthGuard`，请求头携带 `Authorization: Bearer <token>` |
| 当前用户 | `@CurrentUser() user: ChatUser`，所有收藏都归属当前登录用户 |
| 内容类型 | `application/json` |
| Swagger 分组 | `Favorite` |

### 1.1 响应格式

收藏 Controller 内部用 `try/catch` 捕获业务异常，因此业务错误一般也是 HTTP 200，前端统一看 `result`。

当前 [TransformInterceptor](../src/common/core/interceptors/transform.interceptor.ts) 会包装为：

```json
{
  "result": true,
  "code": 0,
  "data": {},
  "message": "收藏成功"
}
```

业务错误示例：

```json
{
  "result": false,
  "code": 0,
  "data": null,
  "message": "收藏类型与消息类型不匹配"
}
```

DTO 校验失败、未登录、token 失效等发生在 Controller 方法体之外，会由全局异常过滤器返回真实 HTTP 状态码：

```json
{
  "result": false,
  "code": 400,
  "data": null,
  "message": "type: 收藏类型不合法",
  "path": "/api/favorites"
}
```

---

## 2. 收藏类型

`FavoriteType` 枚举：

| 收藏类型 | 对应目标 | 要求 |
|---|---|---|
| `MESSAGE` | 文本消息 | `targetId` 必须是 `Message.id`，且消息 `messageType=TEXT` |
| `IMAGE` | 图片消息 | `targetId` 必须是 `Message.id`，且消息 `messageType=IMAGE` |
| `VIDEO` | 视频消息 | `targetId` 必须是 `Message.id`，且消息 `messageType=VIDEO` |
| `FILE` | 文件消息 | `targetId` 必须是 `Message.id`，且消息 `messageType=FILE` |
| `CHAT_RECORD` | 聊天记录/房间片段 | `roomId` 优先作为房间 ID；不传 `roomId` 时用 `targetId` 作为房间 ID |

> 当前没有 `AUDIO` 收藏类型。语音消息如需收藏，需要后端先补 `FavoriteType.AUDIO`。

### 2.1 权限与目标校验

添加收藏时，后端会做以下校验：

| 场景 | 校验规则 |
|---|---|
| `MESSAGE / IMAGE / VIDEO / FILE` | `targetId` 对应的消息必须存在且 `isDeleted=false` |
| `MESSAGE / IMAGE / VIDEO / FILE` | 当前用户必须是该消息所在房间的 `ACTIVE` 成员 |
| `MESSAGE / IMAGE / VIDEO / FILE` | 如果请求传了 `roomId`，必须等于消息真实 `roomId` |
| `MESSAGE / IMAGE / VIDEO / FILE` | 收藏类型必须与消息 `messageType` 匹配 |
| `CHAT_RECORD` | 房间必须存在，当前用户必须是该房间的 `ACTIVE` 成员 |
| `CHAT_RECORD` | 如果 `extra.messageIds` 存在，其中每条消息都必须属于该房间且未删除 |

### 2.2 快照字段

收藏表会保存一份展示快照，避免原消息变动后收藏列表无法展示。对消息类收藏，后端会从真实消息回填：

| 字段 | 来源 |
|---|---|
| `content` | `Message.content` |
| `fileUrl` | `Message.fileUrl` |
| `fileName` | `Message.fileName` |
| `fileSize` | `Message.fileSize` |
| `fileType` | `Message.fileType` |
| `thumbnailUrl` | `Message.thumbnailUrl` |
| `mediaWidth` / `mediaHeight` | `Message.mediaWidth` / `Message.mediaHeight` |
| `duration` | `Message.duration` |
| `roomId` | 消息真实 `roomId` |
| `sourceId` | 默认消息真实 `roomId` |
| `sourceName` | 默认房间 `name` |
| `sourceType` | 私聊房间为 `private`，其他为 `group` |

请求体里传入的 `title / sourceType / sourceId / sourceName / extra` 会被保留；消息内容、文件地址等核心快照以数据库里的真实消息为准。

---

## 3. 接口一览

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 3.1 | GET | `/api/favorites` | 获取当前用户收藏列表 |
| 3.2 | POST | `/api/favorites` | 添加收藏 |
| 3.3 | POST | `/api/favorites/remove` | 取消收藏 |

---

## 4. 接口详情

### 4.1 获取收藏列表

`GET /api/favorites`

按 `collectedAt desc` 返回当前用户的收藏列表。

**Query 参数**：

| 字段 | 类型 | 必填 | 校验 | 说明 |
|---|---|---|---|---|
| `type` | `FavoriteType` | 否 | 枚举值 | 按收藏类型过滤 |
| `take` | number | 否 | `1~100` | 返回条数，默认 `100` |

**请求示例**：

```bash
curl "http://localhost:3000/api/favorites?type=IMAGE&take=20" \
  -H "Authorization: Bearer <token>"
```

**成功响应**：

```jsonc
{
  "result": true,
  "code": 0,
  "message": "收藏列表获取成功",
  "data": [
    {
      "id": "fav1",
      "type": "IMAGE",
      "targetId": "msg1",
      "userId": "userA",
      "sourceType": "private",
      "sourceId": "room1",
      "sourceName": "userA:userB",
      "roomId": "room1",
      "title": "photo.png",
      "content": null,
      "fileUrl": "https://cdn.example.com/photo.png",
      "fileName": "photo.png",
      "fileSize": 123456,
      "fileType": "image/png",
      "thumbnailUrl": "https://cdn.example.com/photo-thumb.png",
      "mediaWidth": 1080,
      "mediaHeight": 720,
      "duration": null,
      "extra": null,
      "collectedAt": "2026-07-10T08:00:00.000Z",
      "createdAt": "2026-07-10T08:00:00.000Z",
      "updatedAt": "2026-07-10T08:00:00.000Z"
    }
  ]
}
```

---

### 4.2 添加收藏

`POST /api/favorites`

**请求体** `CreateFavoriteDto`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `FavoriteType` | 是 | 收藏类型 |
| `targetId` | string | 是 | 收藏目标 ID；消息类为 `Message.id`，聊天记录类通常为房间 ID 或前端生成的记录 ID |
| `sourceType` | string | 否 | 来源类型；不传时消息类自动填 `private/group` |
| `sourceId` | string | 否 | 来源 ID；不传时消息类自动填 `roomId` |
| `sourceName` | string | 否 | 来源名称；不传时消息类自动填房间名 |
| `roomId` | string | 否 | 所属房间 ID；消息类可不传，传了必须与消息真实房间一致；`CHAT_RECORD` 建议必传 |
| `title` | string | 否 | 展示标题；消息类不传时后端自动生成 |
| `content` | string | 否 | 聊天记录类可传摘要；消息类以真实消息内容为准 |
| `fileUrl` | string | 否 | 聊天记录类可传封面/文件；消息类以真实消息为准 |
| `fileName` | string | 否 | 同上 |
| `fileSize` | number | 否 | 整数，`>=0` |
| `fileType` | string | 否 | MIME 类型 |
| `thumbnailUrl` | string | 否 | 缩略图 |
| `mediaWidth` | number | 否 | 整数，`>=0` |
| `mediaHeight` | number | 否 | 整数，`>=0` |
| `duration` | number | 否 | 整数，`>=0`，音视频时长秒数 |
| `extra` | object | 否 | 扩展信息；`CHAT_RECORD` 可传 `{ "messageIds": ["msg1", "msg2"] }` 做消息归属校验 |

#### 文本消息收藏示例

```bash
curl -X POST http://localhost:3000/api/favorites \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "MESSAGE",
    "targetId": "msg_text_1"
  }'
```

#### 图片收藏示例

```bash
curl -X POST http://localhost:3000/api/favorites \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "IMAGE",
    "targetId": "msg_image_1",
    "title": "现场照片"
  }'
```

#### 聊天记录收藏示例

```bash
curl -X POST http://localhost:3000/api/favorites \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "CHAT_RECORD",
    "targetId": "record_room1_20260710_001",
    "roomId": "room1",
    "title": "项目讨论片段",
    "content": "A: 今天先合并收藏接口；B: 收到。",
    "extra": {
      "messageIds": ["msg1", "msg2"]
    }
  }'
```

**成功响应**：

```jsonc
{
  "result": true,
  "code": 0,
  "message": "收藏成功",
  "data": {
    "id": "fav1",
    "type": "MESSAGE",
    "targetId": "msg_text_1",
    "userId": "userA",
    "sourceType": "group",
    "sourceId": "room1",
    "sourceName": "技术交流群",
    "roomId": "room1",
    "title": "小明",
    "content": "今天先合并收藏接口",
    "fileUrl": null,
    "fileName": null,
    "fileSize": null,
    "fileType": null,
    "thumbnailUrl": null,
    "mediaWidth": null,
    "mediaHeight": null,
    "duration": null,
    "extra": null,
    "collectedAt": "2026-07-10T08:00:00.000Z",
    "createdAt": "2026-07-10T08:00:00.000Z",
    "updatedAt": "2026-07-10T08:00:00.000Z"
  }
}
```

**业务错误**：

| 触发条件 | `message` |
|---|---|
| 重复收藏同一 `userId + type + targetId` | `该内容已收藏` |
| 目标消息/房间不存在，或消息已删除 | `收藏目标不存在` |
| 当前用户不是目标房间 `ACTIVE` 成员 | `无权收藏该内容` |
| 请求 `roomId` 与消息真实 `roomId` 不一致 | `收藏目标与房间不匹配` |
| `type` 与消息 `messageType` 不匹配 | `收藏类型与消息类型不匹配` |
| `CHAT_RECORD.extra.messageIds` 中有消息不属于该房间或已删除 | `聊天记录包含不可收藏的消息` |

---

### 4.3 取消收藏

`POST /api/favorites/remove`

按 `type + targetId` 删除当前用户自己的收藏。

**请求体** `RemoveFavoriteDto`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `FavoriteType` | 是 | 收藏类型 |
| `targetId` | string | 是 | 收藏目标 ID |

**请求示例**：

```bash
curl -X POST http://localhost:3000/api/favorites/remove \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "IMAGE",
    "targetId": "msg_image_1"
  }'
```

**成功响应**：返回被删除前的收藏记录。

```jsonc
{
  "result": true,
  "code": 0,
  "message": "取消收藏成功",
  "data": {
    "id": "fav1",
    "type": "IMAGE",
    "targetId": "msg_image_1",
    "userId": "userA",
    "roomId": "room1",
    "collectedAt": "2026-07-10T08:00:00.000Z",
    "createdAt": "2026-07-10T08:00:00.000Z",
    "updatedAt": "2026-07-10T08:00:00.000Z"
  }
}
```

**业务错误**：

| 触发条件 | `message` |
|---|---|
| 当前用户没有这条收藏 | `收藏不存在` |

---

## 5. 前端对接建议

1. 收藏按钮状态建议用列表数据或本地状态判断，目前后端还没有单独的“是否已收藏”查询接口。
2. 添加收藏时，消息类只需要传 `type` 和 `targetId`，展示快照由后端从真实消息补齐。
3. 前端判断接口成败统一看 `result`，不要只看 HTTP 状态码。
4. `type` 必须和消息 `messageType` 对齐：`TEXT -> MESSAGE`，`IMAGE -> IMAGE`，`VIDEO -> VIDEO`，`FILE -> FILE`。
5. `CHAT_RECORD` 如果传 `extra.messageIds`，后端会校验这些消息都属于 `roomId` 且未删除。
