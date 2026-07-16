# 可靠消息客户端示例

[`reliable-chat-client.ts`](./reliable-chat-client.ts) 是一个框架无关的 TypeScript 参考实现，用于演示当前后端的可靠消息投递协议。

它不是独立前端项目，不包含页面、构建配置或登录流程，也不参与 NestJS 后端编译。

## 已实现能力

- 发送前生成并复用 `clientMessageId`
- 持久化 pending 消息队列
- Socket.IO ack 和超时处理
- 断线后的定时重试
- 重连后按房间游标增量同步
- 对实时消息、同步消息和发送 ack 去重
- 接收消息后发送 `message:delivered`
- 进入房间后通过 HTTP 标记已读

## 运行环境

示例面向支持以下 API 的客户端运行环境：

- `fetch`
- `URLSearchParams`
- `crypto.randomUUID`，不可用时会使用降级 ID
- `localStorage`，不可用时仅保留内存状态
- `socket.io-client`

客户端项目需要安装：

```bash
pnpm add socket.io-client
```

## 最小接入示例

```ts
import { ReliableChatClient } from './reliable-chat-client';

const client = new ReliableChatClient({
  // 只填写服务 Origin；示例内部会拼接 /api/chat/...
  apiBaseUrl: 'http://localhost:3000',

  // ChatGateway 使用 /chat namespace，不能只填写服务 Origin
  socketUrl: 'http://localhost:3000/chat',

  getToken: () => localStorage.getItem('accessToken'),
  currentUserId: 'current-user-id',

  onMessage(message) {
    console.log('收到消息', message);
  },

  onQueueChange(queue) {
    console.log('待发送消息数', queue.length);
  },

  onError(error) {
    console.error(error);
  },
});

await client.connect();

client.sendRoomMessage('room-id', {
  messageType: 'TEXT',
  content: '你好',
});
```

## URL 约定

| 配置 | 正确示例 | 说明 |
| --- | --- | --- |
| `apiBaseUrl` | `http://localhost:3000` | 不要附加 `/api`，代码会自行拼接 API 路径 |
| `socketUrl` | `http://localhost:3000/chat` | 必须连接后端 `chat` namespace |

生产环境应使用 HTTPS/WSS 对应的站点地址，并由反向代理正确转发 Socket.IO Upgrade。

## 集成注意事项

- `getToken` 可以返回字符串或 Promise。Token 刷新后，重连前应确保它能返回最新值。
- Electron 不应把长期 Token 存在普通 `localStorage`；应由安全存储或主进程代理提供。
- 示例的 pending 队列适合展示协议，不替代成熟的离线数据库。大量离线消息建议使用 IndexedDB、SQLite 等持久化方案。
- `currentUserId` 用于避免给自己发送的消息回传 `message:delivered`。应从登录状态或 `chat:connected` 事件可靠获取。
- `message:new`、HTTP sync 和发送 ack 可能返回同一条消息，客户端 UI 仍应以服务端 `message.id` 做幂等更新。
- 文件消息应先完成上传，再把服务端返回的 `fileUrl` 和文件元数据放入 pending 队列。
- 调用 `disconnect()` 会停止当前实例的重试计时器并断开 Socket。

## 对应后端契约

- Socket.IO namespace：`/chat`
- 发送群聊消息：`message:sendRoom`
- 发送私聊消息：`message:sendPrivate`
- 接收新消息：`message:new`
- 送达确认：`message:delivered`
- HTTP 增量同步：`GET /api/chat/rooms/:roomId/messages/sync`
- HTTP 标记已读：`POST /api/chat/rooms/:roomId/read`

完整流程和验收场景见 [`docs/frontend-reliable-message-integration.md`](../../docs/frontend-reliable-message-integration.md)，全部实时事件见 [`docs/websocket-realtime-events.md`](../../docs/websocket-realtime-events.md)。
