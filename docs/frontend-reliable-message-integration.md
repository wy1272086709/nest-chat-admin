# 前端可靠消息投递对接文档

> 本文给前端对接当前后端“可靠投递第一版”使用。当前项目后端已经支持：发送幂等、发送 ack、离线补拉、送达确认。前端需要配合实现本地发送队列、重连同步、消息去重。

---

## 1. 前端需要完成什么

| 工作 | 必须 | 说明 |
|---|---|---|
| 发送前生成 `clientMessageId` | 是 | 保证断线/ack 丢失后重试不会重复落库 |
| 本地 pending 发送队列 | 是 | 断网时不丢用户已输入并点击发送的消息 |
| Socket.IO ack 处理 | 是 | 只有服务端 ack 成功，才认为消息真正发送成功 |
| ack 超时重试 | 是 | 使用同一个 `clientMessageId` 重试 |
| 重连后调用 sync | 是 | 补齐离线期间遗漏的消息 |
| 收到消息后去重 | 是 | 同一消息可能来自实时推送、sync、历史接口、发送 ack |
| 收到消息后发 `message:delivered` | 建议 | 让后端记录用户级送达游标 |
| 进入会话后调用已读接口 | 建议 | 更新未读数 |

---

## 2. 后端已经提供的能力

### 2.1 发送消息支持幂等

发送房间消息：

```ts
socket.emit(
  'message:sendRoom',
  {
    roomId: 'room1',
    clientMessageId: 'uuid-from-client',
    messageType: 'TEXT',
    content: 'hello',
  },
  (ack) => {
    console.log(ack);
  },
);
```

发送私聊消息：

```ts
socket.emit(
  'message:sendPrivate',
  {
    receiverId: 'userB',
    clientMessageId: 'uuid-from-client',
    messageType: 'TEXT',
    content: 'hello',
  },
  (ack) => {
    console.log(ack);
  },
);
```

成功 ack：

```json
{
  "result": true,
  "data": {
    "id": "server-message-id",
    "roomId": "room1",
    "senderId": "userA",
    "clientMessageId": "uuid-from-client",
    "content": "hello",
    "messageType": "TEXT",
    "createdAt": "2026-07-11T10:00:00.000Z"
  }
}
```

失败 ack：

```json
{
  "result": false,
  "message": "发送失败原因"
}
```

### 2.2 重连补拉消息

HTTP：

```http
GET /api/chat/rooms/:roomId/messages/sync?afterMessageId=msg1&take=100
```

WebSocket：

```ts
socket.emit(
  'message:sync',
  {
    roomId: 'room1',
    afterMessageId: 'msg1',
    take: 100,
  },
  (ack) => {
    console.log(ack);
  },
);
```

返回：

```json
{
  "result": true,
  "data": {
    "messages": [],
    "nextCursor": {
      "messageId": "msg999",
      "createdAt": "2026-07-11T10:00:00.000Z"
    },
    "hasMore": false
  }
}
```

### 2.3 送达确认

收到消息后发送：

```ts
socket.emit('message:delivered', {
  roomId: 'room1',
  messageId: 'msg999',
});
```

后端会更新 `MessageSyncState`，记录当前用户在该房间已经送达到哪条消息。

---

## 3. 推荐前端状态模型

### 3.1 本地 pending 消息

```ts
type PendingMessage = {
  localId: string;
  clientMessageId: string;
  roomId?: string;
  receiverId?: string;
  content?: string;
  messageType?: 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO';
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  thumbnailUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  retryCount: number;
  createdAt: string;
};
```

### 3.2 房间同步游标

```ts
type RoomCursorMap = Record<string, string>;

const lastSyncedMessageIdByRoom: RoomCursorMap = {
  room1: 'msg999',
};
```

### 3.3 消息去重集合

```ts
const seenMessageIds = new Set<string>();
```

---

## 4. 推荐发送流程

### 4.1 用户点击发送

```text
1. 生成 clientMessageId
2. 写入本地 pending 队列
3. UI 立即展示 pending 消息
4. 如果 socket 在线，立即发送
5. 如果 socket 不在线，等待重连后发送
```

示例：

```ts
function createClientMessageId() {
  return crypto.randomUUID();
}

function sendText(roomId: string, content: string) {
  const pending = {
    localId: crypto.randomUUID(),
    clientMessageId: createClientMessageId(),
    roomId,
    content,
    messageType: 'TEXT' as const,
    status: 'pending' as const,
    retryCount: 0,
    createdAt: new Date().toISOString(),
  };

  savePending(pending);
  renderPendingMessage(pending);
  flushPending();
}
```

### 4.2 发送 pending 队列

```ts
function emitWithTimeout(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('消息发送确认超时'));
    }, timeoutMs);

    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);

      if (!ack?.result) {
        reject(new Error(ack?.message || '消息发送失败'));
        return;
      }

      resolve(ack.data);
    });
  });
}

async function flushPending() {
  if (!socket.connected) return;

  for (const item of getPendingMessages()) {
    markSending(item.clientMessageId);

    try {
      const message = await emitWithTimeout(socket, 'message:sendRoom', {
        roomId: item.roomId,
        clientMessageId: item.clientMessageId,
        content: item.content,
        messageType: item.messageType,
      });

      removePending(item.clientMessageId);
      upsertMessage(message);
    } catch (error) {
      markPending(item.clientMessageId);
    }
  }
}
```

关键点：

- 重试必须复用原来的 `clientMessageId`。
- 不要因为 ack 超时就生成新消息 ID。
- 服务端返回成功后，用服务端 `message.id` 替换本地 pending 消息。

---

## 5. 推荐接收流程

### 5.1 实时消息

```ts
socket.on('message:new', (message) => {
  upsertMessage(message);
  markDelivered(message);
});

socket.on('message:moderated', ({ messageId, roomId }) => {
  removeMessageFromLocalState(roomId, messageId);
  void syncRoomMessages(roomId);
});

socket.on('moderation:warning', ({ message }) => {
  showWarning(message);
});

socket.on('moderation:restricted', ({ expiresAt }) => {
  disableMessageSendingUntil(expiresAt);
});
```

### 5.2 消息去重

```ts
function upsertMessage(message) {
  if (seenMessageIds.has(message.id)) return;

  seenMessageIds.add(message.id);
  appendMessageToRoom(message.roomId, message);
  saveRoomCursor(message.roomId, message.id);
}
```

为什么必须去重？

同一条消息可能来自：

- `message:new`
- `message:sync`
- HTTP 历史消息
- 发送 ack
- 重试后服务端返回已有消息

### 5.3 送达确认

```ts
function markDelivered(message) {
  if (message.senderId === currentUserId) return;

  socket.emit('message:delivered', {
    roomId: message.roomId,
    messageId: message.id,
  });
}
```

---

## 6. 推荐重连流程

```text
socket reconnect
  -> 重新鉴权成功
  -> 拉会话列表 /api/chat/rooms
  -> 对每个会话按 afterMessageId 调用 sync
  -> 补齐消息并去重
  -> 重发 pending 队列
```

示例：

```ts
socket.on('connect', async () => {
  const conversations = await fetchConversations();

  for (const item of conversations) {
    const roomId = item.room.id;
    const afterMessageId = getRoomCursor(roomId);

    await syncRoom(roomId, afterMessageId);
  }

  await flushPending();
});

async function syncRoom(roomId: string, afterMessageId?: string) {
  const params = new URLSearchParams();
  if (afterMessageId) params.set('afterMessageId', afterMessageId);
  params.set('take', '100');

  const res = await fetch(`/api/chat/rooms/${roomId}/messages/sync?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const body = await res.json();
  if (!body.result) throw new Error(body.message || '同步失败');

  for (const message of body.data.messages) {
    upsertMessage(message);
    markDelivered(message);
  }
}
```

---

## 7. 已读处理

用户进入房间并读完消息后，调用已有接口：

```http
POST /api/chat/rooms/:roomId/read
```

示例：

```ts
async function markRoomRead(roomId: string) {
  await fetch(`/api/chat/rooms/${roomId}/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
```

当前后端已读是 `lastReadAt`，不是精确到某条消息。现阶段够用。

---

## 8. 本地持久化建议

前端至少持久化两类数据：

```ts
type ReliableChatLocalState = {
  pendingMessages: PendingMessage[];
  roomCursors: Record<string, string>;
};
```

Web 可用：

- `localStorage`
- `IndexedDB`

移动端可用：

- SQLite
- MMKV
- AsyncStorage

如果消息里有图片/文件，本地 pending 队列要保存上传后的 `fileUrl`，不要只保存本地临时路径。

---

## 9. 页面状态建议

消息 UI 可以按状态展示：

| 状态 | UI |
|---|---|
| `pending` | 灰色/转圈 |
| `sending` | 转圈 |
| `sent` | 正常展示 |
| `failed` | 红色重试按钮 |

发送失败时不要直接删除用户消息，除非用户手动取消。

---

## 10. 参考实现

仓库里提供了一个框架无关的参考实现：

```text
examples/reliable-messaging/reliable-chat-client.ts
```

它包含：

- `clientMessageId` 生成
- pending 队列
- ack timeout
- 重试
- 重连 sync
- `message:delivered`
- 消息去重

这个文件不参与后端编译。使用前请先阅读同目录的 `README.md`，确认依赖、HTTP 基址和 Socket.IO namespace，再复制到前端项目或按实际状态管理方式改造。

---

## 11. 前端验收清单

| 场景 | 预期 |
|---|---|
| 正常在线发送 | UI 先出现 pending，ack 后替换为服务端消息 |
| 发送后 ack 丢失/超时 | 前端保留 pending，并用同一个 `clientMessageId` 重试 |
| 重试同一消息 | 后端返回同一条消息，不重复展示 |
| 接收方离线 | 上线后 sync 能补到离线消息 |
| 收到 `message:new` 后刷新页面 | 历史/sync 不重复展示 |
| 收到消息 | 前端发送 `message:delivered` |
| 进入房间 | 调用 read 接口清未读 |
| 断网连续发多条 | 恢复网络后按队列重发，不丢本地消息 |
