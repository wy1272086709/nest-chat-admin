# Nest Admin API Documentation

> Auto-generated from source code in `/src`.
>
> **Base URL**: `http://localhost:{PORT}/{GLOBAL_PREFIX}` (defaults to `http://localhost:3000/api`)
> **Swagger UI**: `http://localhost:3000/docs`
> **Version**: 1.0
>
> **Last Updated**: April 9, 2026

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [TypeScript Types](#typescript-types)
- [Modules](#modules)
  - [User Module](#user-module)
  - [Chat Module (HTTP)](#chat-module-http)
  - [Notification Module](#notification-module)
  - [MinIO Module](#minio-module)
  - [Chat WebSocket Gateway](#chat-websocket-gateway)

---

## Overview

NestJS-based admin + chat backend. Global prefix `/api` is applied to all HTTP routes. A subset of routes is marked `@Public()` and skips JWT auth; all others require a valid Bearer token.

Application bootstrap is in `src/main.ts:7`. Routes are registered under:

| Module          | Controller file                                         | Base path            |
| --------------- | ------------------------------------------------------- | -------------------- |
| User            | `src/user/controllers/user.controller.ts`               | `/api/users`         |
| Chat            | `src/chat/chat.controller.ts`                           | `/api/chat`          |
| Notification    | `src/notification/notification.controller.ts`           | `/api/notifications` |
| MinIO           | `src/minio/minio.controller.ts`                         | `/api/minio`         |
| Chat (WebSocket)| `src/chat/chat.gateway.ts` (namespace: `/chat`)         | Socket.IO            |

---

## Authentication

Authentication uses **JWT Bearer tokens** via Passport (`AuthGuard('jwt')`). The guard `src/common/auth/guards/jwt-auth.guard.ts:7` is registered globally in `AppModule`, so every route is protected by default. Mark a handler with `@Public()` (`src/common/auth/decorators/public.decorator.ts`) to opt out.

### Obtaining a token

Call `POST /api/users/login` with valid credentials. The response `data` contains `access_token` and the authenticated user object.

### Using the token

Send the token on every authenticated request:

```
Authorization: Bearer <access_token>
```

WebSocket clients pass the token via `handshake.auth.token` or the `Authorization` header.

### Error responses from the guard

| Condition                          | HTTP Status | Message                              |
| ---------------------------------- | ----------- | ------------------------------------ |
| Missing `Authorization` header     | 401         | `缺少 Authorization 请求头`           |
| Token expired (`TokenExpiredError`)| 401         | `Token 已过期，请重新登录`            |
| Token invalid (`JsonWebTokenError`)| 401         | `Token 无效，请重新登录`              |
| Any other auth failure             | 401         | `认证失败，请重新登录`                |

---

## Response Format

All successful responses pass through `TransformInterceptor` (`src/common/core/interceptors/transform.interceptor.ts:25`), which forces HTTP 200 and wraps the payload:

```jsonc
{
  "result": true,      // boolean — request success/failure
  "code": 0,           // 0 on success; HTTP status on error
  "data": { ... },     // endpoint-specific payload (or null)
  "message": "..."     // human-readable status message (optional)
}
```

Controllers return a partial `{ result, data, message }` shape; the interceptor fills in `code: 0`.

---

## Error Handling

Unhandled exceptions are caught by `GlobalExceptionFilter` (`src/common/core/filters/exception.filter.ts:12`) and normalized to the same envelope:

```jsonc
{
  "result": false,
  "code": 400,                 // actual HTTP status
  "data": null,
  "message": "Validation error message",
  "path": "/api/users/login"   // debugging aid
}
```

Validation errors from `class-validator` produce a `400 Bad Request` with the first validation message. Internal exceptions produce `500`.

---

## TypeScript Types

Core shared types used throughout the API.

```ts
// src/common/core/interceptors/transform.interceptor.ts:11
export interface Response<T> {
  result: boolean;
  code: number;
  data: T;
  message?: string;
}

export interface DataResult<T extends Record<string, any> | null> {
  data: T;
  message?: string;
  result: boolean;
}

// src/user/dto/user.dto.ts
export enum EmailVerificationType {
  REGISTER = 'register',
  FORGET_PASSWORD = 'forgetPassword',
}

// src/notification/dto/notification.dto.ts
export enum FriendRequestAction {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

// src/user/dto/user.dto.ts:142
export interface UserResponseDto {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  bio?: string;
  status: 'ACTIVE' | 'INACTIVE' | 'BANNED'; // UserStatus enum
  role: { id: string; name: string; description?: string };
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

// Login response payload
export interface LoginResultDto {
  access_token: string;
  user: Omit<ChatUser, 'passwordHash'>;
}
```

---

## Modules

### User Module

Controller: `src/user/controllers/user.controller.ts:22` — base path `/api/users`.

#### `POST /api/users/register`

Register a new account (public).

- **Auth**: `@Public()` — no token required.
- **DTO**: `CreateUserDto`

```ts
export class CreateUserDto {
  username: string;                  // required
  email: string;                     // required, valid email
  nickname: string;                  // required
  password: string;                  // required, min 6 chars
  confirmPassword: string;           // must match `password`
  avatarUrl?: string;                // optional
  bio?: string;                      // optional
  code: string;                      // email verification code
}
```

- **Flow**: Verifies `code` against the Redis key `verificationCode:{email}:register` (issued by `POST /api/users/sendEmail` with `type=register`). On success, creates the user.
- **Response** `data`: `Partial<ChatUser>` or `null`.

```bash
curl -X POST http://localhost:3000/api/users/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "nickname": "Alice",
    "password": "secret123",
    "confirmPassword": "secret123",
    "code": "123456"
  }'
```

```json
{
  "result": true,
  "code": 0,
  "data": { "id": "uuid", "username": "alice", "email": "alice@example.com" },
  "message": "注册成功"
}
```

**Errors**: `result: false`, `message: "验证码错误"` on bad code.

---

#### `POST /api/users/sendEmail`

Send a verification code to an email (public).

- **Auth**: `@Public()`.
- **DTO**: `SendEmailDto`

```ts
export class SendEmailDto {
  to: string;                                  // recipient email
  type: 'register' | 'forgetPassword';         // EmailVerificationType
}
```

- **Flow**: Generates a 6-digit code, stores it in Redis with a 10-minute TTL, enforces a 60-second rate limit per `(email, type)`, then sends via SMTP.
- **Response** `data`: `{ code: string }` (the code is echoed back — intended for dev only).

```bash
curl -X POST http://localhost:3000/api/users/sendEmail \
  -H "Content-Type: application/json" \
  -d '{ "to": "alice@example.com", "type": "register" }'
```

**Errors**: `message: "请稍后重试，避免频繁发送"` when rate-limited.

---

#### `POST /api/users/forgetPassword`

Reset password via email code (public).

- **Auth**: `@Public()`.
- **DTO**: `ForgetPasswordDto`

```ts
export class ForgetPasswordDto {
  username: string;            // must exist and match `email`
  email: string;               // valid email
  code: string;                // verification code (type=forgetPassword)
  password: string;            // new password, min 6 chars
  confirmPassword: string;     // must match `password`
}
```

- **Flow**: Looks up user by `username`, verifies `email` matches, validates code against `verificationCode:{email}:forgetPassword`, hashes the new password with bcrypt (cost 10), updates the user, then deletes the Redis code.
- **Response** `data`: `{ username, email }`.

```bash
curl -X POST http://localhost:3000/api/users/forgetPassword \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com",
    "code": "123456",
    "password": "newsecret123",
    "confirmPassword": "newsecret123"
  }'
```

**Errors**: `用户不存在`, `邮箱与用户不匹配`, `验证码已过期或不存在`, `验证码错误`.

---

#### `POST /api/users/login`

Authenticate and receive a JWT (public).

- **Auth**: `@Public()`.
- **DTO**: `LoginDto`

```ts
export class LoginDto {
  account: string;   // email or username
  password: string;  // min 6 chars
}
```

- **Flow**: `AuthService.validateUser` (`src/common/auth/services/auth.service.ts:23`) tries `email` first, then `username`, and compares the bcrypt hash. On success, updates `lastLoginAt` and signs a JWT.
- **Response** `data`: `{ access_token: string, user: Omit<ChatUser, 'passwordHash'> }`.

```bash
curl -X POST http://localhost:3000/api/users/login \
  -H "Content-Type: application/json" \
  -d '{ "account": "alice@example.com", "password": "secret123" }'
```

```json
{
  "result": true,
  "code": 0,
  "data": {
    "access_token": "eyJhbGciOi...",
    "user": { "id": "uuid", "username": "alice", "email": "alice@example.com" }
  },
  "message": "登录成功"
}
```

**Errors**: `用户名或密码错误`.

---

#### `POST /api/users/logout`

Invalidate the current session.

- **Auth**: required (current user derived from `@CurrentUser()`).
- **Body**: none.
- **Response** `data`: `null`.

```bash
curl -X POST http://localhost:3000/api/users/logout \
  -H "Authorization: Bearer <token>"
```

> Note: `AuthService.logout` (`src/common/auth/services/auth.service.ts:92`) is currently a no-op stub; token revocation is not implemented server-side.

---

#### `POST /api/users/saveProfile`

Update the authenticated user's profile.

- **Auth**: required.
- **DTO**: `UpdateUserDto`

```ts
export class UpdateUserDto {
  username?: string;
  email?: string;        // valid email if provided
  nickname: string;      // required
  avatarUrl?: string;
}
```

- **Response** `data`: the updated `ChatUser`.

```bash
curl -X POST http://localhost:3000/api/users/saveProfile \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "nickname": "Alice W.", "avatarUrl": "https://cdn/x.png" }'
```

---

#### `POST /api/users/searchFriend`

Search for an exact friend match (scoped to current user).

- **Auth**: required.
- **DTO**: `SearchDto` — `{ query: string }`.
- **Response** `data`: `ChatUser[]` (0 or 1 element).

```bash
curl -X POST http://localhost:3000/api/users/searchFriend \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "query": "alice" }'
```

---

#### `POST /api/users/searchUsers`

Fuzzy search all users.

- **Auth**: required.
- **DTO**: `SearchDto` — `{ query: string }`.
- **Response** `data`: `ChatUser[]`.

```bash
curl -X POST http://localhost:3000/api/users/searchUsers \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "query": "ali" }'
```

---

#### `POST /api/users/addFriend`

Send a friend request to another user.

- **Auth**: required.
- **DTO**: `AddFriendDto`

```ts
export class AddFriendDto {
  receiverId: string;   // target user id
  message?: string;     // optional note
}
```

- **Response** `data`: `null` (success message on success).

```bash
curl -X POST http://localhost:3000/api/users/addFriend \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "receiverId": "uuid", "message": "Hi!" }'
```

---

#### `GET /api/users/friends`

List the current user's friends.

- **Auth**: required.
- **Response** `data`: friend list shape returned by `UserService.getFriends`.

```bash
curl -X GET http://localhost:3000/api/users/friends \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/users/groups`

List the current user's joined group chats (with role and member count, excluding private chats).

- **Auth**: required.
- **Response** `data`: array (always normalized to an array, even on empty).

```bash
curl -X GET http://localhost:3000/api/users/groups \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/users`

List all users.

- **Auth**: required.
- **Response** `data`: `ChatUser[]` (raw service output — not wrapped by the controller, but wrapped by the interceptor).

```bash
curl -X GET http://localhost:3000/api/users \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/users/:id`

Get a single user by id.

- **Auth**: required.
- **Path**: `id` (string).
- **Response** `data`: `ChatUser | null`.

```bash
curl -X GET http://localhost:3000/api/users/abc123 \
  -H "Authorization: Bearer <token>"
```

> **Routing order note**: This dynamic route is declared last in the controller (`src/user/controllers/user.controller.ts:373`) so that `/friends`, `/groups`, etc. are not shadowed.

---

### Chat Module (HTTP)

Controller: `src/chat/chat.controller.ts:19` — base path `/api/chat`. Tagged `@ApiTags('Chat')`.

The HTTP controller and `ChatGateway` (WebSocket) share `ChatService`, so business logic is not duplicated. HTTP endpoints are best for request/response operations (history, conversations); WebSocket events are best for real-time messaging (see [Chat WebSocket Gateway](#chat-websocket-gateway)).

#### `POST /api/chat/rooms/group`

Create a group chat and notify all members in real time.

- **Auth**: required.
- **DTO**: `CreateGroupRoomDto`

```ts
export class CreateGroupRoomDto {
  name: string;             // required
  description?: string;
  memberIds?: string[];     // user ids to add as members
}
```

- **Side effect**: emits `room:created` to all member sockets via `ChatGateway.emitToUsers`.
- **Response** `data`: the created room (with members).

```bash
curl -X POST http://localhost:3000/api/chat/rooms/group \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Team A", "memberIds": ["uuid1", "uuid2"] }'
```

---

#### `POST /api/chat/rooms/private`

Get (or create) a 1:1 private room with a target user.

- **Auth**: required.
- **DTO**: `InitPrivateRoomDto`

```ts
export class InitPrivateRoomDto {
  receiverId: string;   // required
}
```

- **Side effect**: emits `room:private` to both members.
- **Response** `data`: the private room.

```bash
curl -X POST http://localhost:3000/api/chat/rooms/private \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "receiverId": "uuid" }'
```

---

#### `GET /api/chat/rooms`

List the current user's conversations (group + private), each with last message and unread count.

- **Auth**: required.
- **Response** `data`: conversation list.

```bash
curl -X GET http://localhost:3000/api/chat/rooms \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/chat/rooms/:roomId/messages`

Page through a room's history (already-filtered for messages the caller has cleared).

- **Auth**: required (must be a member).
- **Path**: `roomId`.
- **Query**: `HistoryQueryDto` — `take?: number` (1..100).
- **Response** `data`: message array.

```bash
curl -X GET "http://localhost:3000/api/chat/rooms/abc/messages?take=50" \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/chat/rooms/:roomId/members`

List members of a room.

- **Auth**: required (must be a member).
- **Response** `data`: member list.

```bash
curl -X GET http://localhost:3000/api/chat/rooms/abc/members \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /api/chat/rooms/:roomId/read`

Mark a room as read for the current user.

- **Auth**: required.
- **Side effect**: emits `room:read` to the room.
- **Response** `data`: `{ lastReadAt: Date }` (result of `ChatService.markRoomRead`).

```bash
curl -X POST http://localhost:3000/api/chat/rooms/abc/read \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /api/chat/rooms/:roomId/clear`

Hide all messages in a room for the current user (does not delete originals).

- **Auth**: required.
- **Response** `data`: result of `ChatService.clearRoom`.

```bash
curl -X POST http://localhost:3000/api/chat/rooms/abc/clear \
  -H "Authorization: Bearer <token>"
```

---

### Notification Module

Controller: `src/notification/notification.controller.ts:8` — base path `/api/notifications`.

#### `GET /api/notifications`

List all notifications received by the current user (friend requests, group invites, etc.).

- **Auth**: required.
- **Response** `data`: notification array.

```bash
curl -X GET http://localhost:3000/api/notifications \
  -H "Authorization: Bearer <token>"
```

---

#### `GET /api/notifications/friendRequests`

List friend request notifications only.

- **Auth**: required.

```bash
curl -X GET http://localhost:3000/api/notifications/friendRequests \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /api/notifications/markRead`

Mark a single notification as read.

- **Auth**: required.
- **DTO**: `MarkNotificationReadDto` — `{ notificationId: string }`.

```bash
curl -X POST http://localhost:3000/api/notifications/markRead \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "notificationId": "uuid" }'
```

---

#### `POST /api/notifications/markAllRead`

Mark all of the current user's notifications as read.

- **Auth**: required.
- **Body**: none.

```bash
curl -X POST http://localhost:3000/api/notifications/markAllRead \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /api/notifications/handleFriendRequest`

Accept or reject a friend request notification.

- **Auth**: required.
- **DTO**: `HandleFriendRequestDto`

```ts
export class HandleFriendRequestDto {
  notificationId: string;
  action: 'ACCEPTED' | 'REJECTED';   // FriendRequestAction
}
```

```bash
curl -X POST http://localhost:3000/api/notifications/handleFriendRequest \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "notificationId": "uuid", "action": "ACCEPTED" }'
```

---

### MinIO Module

Controller: `src/minio/minio.controller.ts:4` — base path `/api/minio`.

#### `GET /api/minio/presignedUrl`

Generate a presigned PUT URL for direct browser upload to the MinIO `public` bucket.

- **Auth**: required (no `@Public()` marker; covered by the global guard).
- **Query**: `name` — target object name in the bucket.
- **TTL**: 3600 seconds (1 hour).
- **Response** `data`: `{ url: string }`.
- **Errors**: On MinIO failure the controller rethrows, so the request falls through to `GlobalExceptionFilter` and returns the appropriate HTTP status.

```bash
curl -X GET "http://localhost:3000/api/minio/presignedUrl?name=avatars/alice.png" \
  -H "Authorization: Bearer <token>"
```

```json
{
  "result": true,
  "code": 0,
  "data": { "url": "https://minio.example.com/public/avatars/alice.png?X-Amz-..." },
  "message": "预签名URL生成成功"
}
```

---

### Chat WebSocket Gateway

Gateway: `src/chat/chat.gateway.ts:31` — Socket.IO namespace `/chat`. Authenticates via the same JWT used for HTTP.

#### Connection handshake

1. Client connects to `/chat` and provides the JWT in `handshake.auth.token` **or** the `Authorization: Bearer <token>` header (`getToken`, `src/chat/chat.gateway.ts:168`).
2. The gateway verifies the token and looks up the user. On success it joins the socket to a personal room `user:{id}` and emits `chat:connected`. On failure it emits `chat:error` and disconnects.

#### Client → Server events

| Event                  | Payload                                              | Acknowledgement                                |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| `room:join`            | `{ roomId: string }`                                 | `room:joined` `{ roomId }`                     |
| `room:createGroup`     | `CreateGroupRoomDto` (`{ name, description?, memberIds? }`) | `room:created` `{ room }` (also broadcast to members) |
| `message:sendRoom`     | `SendRoomMessageDto`                                 | `message:sent` `{ message }`                   |
| `message:sendPrivate`  | `SendPrivateMessageDto`                              | `message:sent` `{ room, message }`             |
| `message:list`         | `GetMessagesDto`                                     | `message:list` `{ messages }`                  |
| `room:read`            | `{ roomId: string }`                                 | `room:read` `{ lastReadAt }`                   |
| `room:clear`           | `{ roomId: string }`                                 | `room:cleared` `{ result }`                    |

`MessageContentDto` (base for `SendRoomMessageDto` / `SendPrivateMessageDto`):

```ts
export abstract class MessageContentDto {
  messageType?: MessageType;        // TEXT | IMAGE | FILE | AUDIO | VIDEO
  content?: string;                 // required when messageType is TEXT/omitted
  fileUrl?: string;                 // required for non-TEXT types
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  thumbnailUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
}

export class SendRoomMessageDto extends MessageContentDto {
  roomId: string;
}

export class SendPrivateMessageDto extends MessageContentDto {
  receiverId: string;
}
```

#### Server → Client events

| Event          | Triggered by                                          | Payload                                      |
| -------------- | ----------------------------------------------------- | -------------------------------------------- |
| `chat:connected` | Successful socket handshake                         | `{ userId }`                                 |
| `chat:error`     | Handshake/verification failure                      | `{ message }`                                |
| `room:created`   | Group room created (HTTP or WS)                     | `room`                                       |
| `room:private`   | Private room created/refreshed                       | `room`                                       |
| `room:read`      | A member marked the room read                       | `{ roomId, userId, lastReadAt }`             |
| `room:cleared`   | Current user cleared the room (emitted to self)     | `clearRoom` result                           |
| `message:new`    | A new message arrived (room or private)             | `message`                                    |

---

## Appendix: Global configuration

| Setting          | Env var          | Default | Source                          |
| ---------------- | ---------------- | ------- | ------------------------------- |
| Global prefix    | `GLOBAL_PREFIX`  | `/api`  | `src/main.ts:12`                |
| Port             | `PORT`           | `3000`  | `src/main.ts:29`                |
| JWT expiration   | `jwt.expiresIn`  | —       | `src/common/auth/services/auth.service.ts:51` |
| Swagger UI path  | (hardcoded)      | `/docs` | `src/main.ts:26`                |