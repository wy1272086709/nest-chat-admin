# 认证会话控制设计

本文记录当前项目的账号封禁、单端登录挤下线、WebSocket 单 token 无感续期方案。

## 1. 目标

当前认证模型使用一个 access token，不引入 refresh token。需要同时支持：

- JWT 默认有效期 7 天。
- WebSocket 长连接期间 token 快过期时无感续期，不中断聊天会话。
- 同一个账号只允许一个有效登录会话，后登录挤掉前登录。
- 用户违规后可禁用账号，HTTP 与 WebSocket 都要立即失效。

## 2. 核心概念

### 2.1 账号状态

账号状态来自 `ChatUser.status`：

```txt
ACTIVE
INACTIVE
BANNED
```

只有 `ACTIVE` 用户可以登录、访问 HTTP 接口、建立 WebSocket 连接和继续发送 WebSocket 消息。

账号封禁是用户级能力。只要用户状态不是 `ACTIVE`，该账号所有 token 和所有连接都应失效。

### 2.2 jti

`jti` 是当前登录会话的唯一 ID。每次登录都会生成一个新的 `jti`，并写入 JWT payload：

```json
{
  "sub": "userId",
  "email": "user@example.com",
  "username": "alice",
  "jti": "uuid",
  "iat": 123,
  "exp": 456
}
```

`jti` 用于区分同一账号的不同登录会话。它不是封号标识，而是“这一次登录”的标识。

### 2.3 Redis 当前会话

Redis 只保存每个用户当前有效的 `jti`：

```txt
auth:current-jti:<userId> = <jti>
TTL = JWT 剩余有效期
```

后登录时会生成新 `jti` 并覆盖这个 key。旧 token 中的 `jti` 与 Redis 当前值不一致，因此旧会话失效。

## 3. 登录流程

入口：

```txt
POST /api/users/login
```

流程：

1. `AuthService.validateUser()` 校验账号密码。
2. 校验用户状态，只有 `ACTIVE` 可以继续。
3. `UserController.login()` 调用 `ChatGateway.disconnectUser(user.id)`，通知并断开该用户已有 WebSocket 连接。
4. `AuthService.login()` 生成新的 `jti`。
5. 签发 JWT，并将 `auth:current-jti:<userId>` 写入 Redis。
6. 返回 `access_token`。

效果：

- 新登录会话成为唯一有效会话。
- 旧 HTTP token 在下一次请求时失效。
- 旧 WebSocket 连接会收到 `auth:kicked` 并断开。

## 4. HTTP 鉴权流程

全局 `JwtAuthGuard` 进入 Passport JWT 策略后，执行：

```txt
JwtStrategy.validate(payload)
  -> AuthService.validatePayload(payload)
```

校验内容：

1. 根据 `payload.sub` 查询用户。
2. 用户必须存在。
3. 用户状态必须是 `ACTIVE`。
4. `payload.jti` 必须等于 Redis 中的 `auth:current-jti:<userId>`。

失败语义：

```txt
用户不存在                -> 401
账号已被禁用              -> 401
登录会话已失效，请重新登录  -> 401
账号已在其他设备登录        -> 401
```

## 5. HTTP token 无感续期

HTTP 使用 `TokenRefreshInterceptor`：

1. 读取 `Authorization: Bearer <token>`。
2. decode token，要求存在 `exp` 和 `jti`。
3. 如果剩余有效期小于 24 小时，调用 `AuthService.refreshAccessToken(user, jti)`。
4. 刷新时沿用原 `jti`，并延长 Redis 当前会话 key 的 TTL。
5. 新 token 通过响应头返回：

```txt
Authorization: Bearer <newToken>
Refresh-Token: true
```

注意：续期不会生成新的 `jti`，否则会破坏当前会话一致性。

## 6. WebSocket 握手流程

Gateway：

```txt
namespace: /chat
```

客户端传 token：

```js
io('http://localhost:3000/chat', {
  auth: { token: '<jwt>' },
});
```

服务端流程：

1. `ChatGateway.handleConnection()` 从 handshake 读取 token。
2. `AuthService.verifyToken()` 校验签名与过期时间。
3. `AuthService.validatePayload()` 校验账号状态和 Redis 当前 `jti`。
4. 将用户信息、`tokenExpiresAt`、`tokenJti` 保存到 `client.data`。
5. 加入个人房间：

```txt
user:<userId>
```

连接成功后发送：

```txt
chat:connected
```

## 7. WebSocket 消息期间校验与续期

`ChatGateway` 使用 `WsTokenRefreshInterceptor` 包裹所有订阅事件。

每次客户端发送聊天事件时，拦截器都会：

1. 根据 `client.data.user.id` 查询用户。
2. 用户状态必须是 `ACTIVE`。
3. `client.data.tokenJti` 必须等于 Redis 当前 `jti`。
4. 如果 token 剩余有效期小于 24 小时，调用 `AuthService.refreshAccessToken()`。
5. 刷新成功后通过事件下发新 token：

```txt
auth:tokenRefreshed
```

payload：

```json
{
  "access_token": "<newToken>",
  "token_type": "Bearer",
  "expires_at": "2026-07-15T00:00:00.000Z",
  "expires_in": 604800
}
```

为了避免高频消息导致频繁签发 token，同一个 socket 最多每 60 秒刷新一次。

## 8. WebSocket 失效事件

服务端会使用以下事件通知前端：

| 事件 | 场景 | 前端建议 |
|---|---|---|
| `auth:tokenRefreshed` | WS token 已续期 | 更新本地 token 和 `socket.auth.token` |
| `auth:kicked` | 账号在其他设备登录，当前会话失效 | 清理登录态并跳转登录 |
| `auth:disabled` | 账号被禁用 | 清理登录态，展示封禁提示 |
| `chat:error` | 握手认证失败或其他连接错误 | 展示错误并断开 |

前端示例：

```js
socket.on('auth:tokenRefreshed', ({ access_token }) => {
  localStorage.setItem('access_token', access_token);
  socket.auth = { token: access_token };
});

socket.on('auth:kicked', ({ message }) => {
  clearAuth();
  showMessage(message);
  redirectToLogin();
});

socket.on('auth:disabled', ({ message }) => {
  clearAuth();
  showMessage(message);
  redirectToLogin();
});
```

## 9. 封号流程

入口：

```txt
PUT /api/users/:id/status
```

body：

```json
{
  "status": "BANNED"
}
```

流程：

1. `UserService.changeStatus()` 更新 `ChatUser.status`。
2. 如果新状态不是 `ACTIVE`，调用：

```txt
ChatGateway.disconnectUser(userId, '账号已被禁用', 'auth:disabled')
```

3. 在线 WebSocket 连接收到 `auth:disabled` 并断开。
4. 后续 HTTP 请求因 `JwtStrategy.validate()` 校验用户状态失败而返回 401。
5. 后续 WebSocket 消息因 `WsTokenRefreshInterceptor` 校验用户状态失败而断开。

## 10. 退出登录流程

入口：

```txt
POST /api/users/logout
```

流程：

1. 当前用户由 JWT 注入，包含 `tokenJti`。
2. `AuthService.logout()` 读取 Redis 当前 `jti`。
3. 如果当前请求的 `tokenJti` 等于 Redis 当前值，则删除：

```txt
auth:current-jti:<userId>
```

效果：

- 当前 token 失效。
- 该账号需要重新登录获得新 `jti`。

## 11. 旧 token 兼容性

新方案要求 JWT payload 中必须包含 `jti`。历史 token 没有 `jti`，会被判定为：

```txt
登录会话已失效，请重新登录
```

上线该方案后，旧用户需要重新登录一次。

## 12. 当前方案边界

当前方案没有维护 token 黑名单列表，而是维护“用户当前有效 jti”。这更适合单端登录：

```txt
auth:current-jti:<userId>
```

如果未来要支持多端同时在线，并只踢某一台设备，则需要改成会话表或 Redis session set，例如：

```txt
auth:sessions:<userId> = Set<jti>
auth:session:<jti> = device/session metadata
```

当前方案也没有单独的 refresh token。access token 通过 HTTP 响应头或 WebSocket 事件续期，续期前仍会检查账号状态和当前 `jti`。

## 13. 涉及文件

核心实现：

- `src/common/auth/services/auth.service.ts`
- `src/common/auth/strategies/jwt.strategy.ts`
- `src/common/auth/interceptors/token-refresh.interceptor.ts`
- `src/common/auth/interceptors/ws-token-refresh.interceptor.ts`
- `src/chat/chat.gateway.ts`
- `src/user/controllers/user.controller.ts`
- `src/user/dto/user.dto.ts`
- `src/user/services/user.service.ts`

配置：

- `config/common.ts`
- `config/env.validation.ts`
- `src/common/auth/auth-business.module.ts`
