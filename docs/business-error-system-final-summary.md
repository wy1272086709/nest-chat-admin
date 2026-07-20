# 全局业务异常与 WebSocket 错误协议最终总结

## 1. 改造目标

本次改造解决以下问题：

- HTTP 业务失败被 Controller 捕获后返回 `200 + result:false`；
- 调用方依赖中文 `message` 判断错误原因；
- 认证、AI、聊天等模块缺少稳定业务码；
- WebSocket 各事件的错误格式不一致；
- 未知异常可能向 WebSocket 客户端暴露内部错误信息；
- 注册前置查询无法覆盖并发写入导致的唯一索引冲突。

## 2. 最终结构

```text
HTTP 正常返回
  -> TransformInterceptor
  -> ResponseFactory
  -> HTTP 2xx + code 0

HTTP 业务失败
  -> BusinessException
  -> GlobalExceptionFilter
  -> 真实 HTTP 4xx/5xx + 具体业务码

HTTP 未知异常
  -> GlobalExceptionFilter
  -> HTTP 500 + INTERNAL_ERROR

WebSocket 业务失败
  -> BusinessException
  -> WsExceptionFilter / ACK catch
  -> { result:false, code:具体业务码, message:安全业务提示 }

WebSocket 未知异常
  -> WsExceptionFilter / ACK catch
  -> { result:false, code:INTERNAL_ERROR, message:通用提示 }
```

核心文件：

- `src/common/core/constants/business-error-code.constant.ts`
- `src/common/core/exceptions/business.exception.ts`
- `src/common/core/responses/response.factory.ts`
- `src/common/core/filters/exception.filter.ts`
- `src/common/core/interceptors/transform.interceptor.ts`
- `src/chat/ws-error-response.ts`
- `src/chat/ws-exception.filter.ts`

## 3. HTTP 响应契约

成功响应：

```json
{
  "result": true,
  "code": 0,
  "data": {},
  "message": "操作成功"
}
```

业务失败示例：

```http
HTTP/1.1 409 Conflict
```

```json
{
  "result": false,
  "code": 20001,
  "data": null,
  "message": "该邮箱已注册，请直接登录",
  "path": "/api/users/register"
}
```

`code` 是稳定业务码，HTTP 状态表达协议层错误类别，两者不能相互替代。

## 4. WebSocket 错误契约

WebSocket 没有 HTTP 响应状态，使用独立协议：

```json
{
  "result": false,
  "code": 30001,
  "message": "你不是该房间的成员"
}
```

`WsExceptionFilter` 覆盖未局部捕获的 Gateway 事件。需要通过 Socket.IO ACK 返回错误的发送事件保留局部 `catch`，但统一调用 `createWsErrorResponse()`。

只有 `BusinessException` 可以把具体消息返回客户端。数据库、Redis、MQ、第三方 SDK 和程序错误统一返回：

```json
{
  "result": false,
  "code": 90000,
  "message": "服务异常，请稍后再试"
}
```

完整堆栈只记录在服务端日志中。

## 5. 注册并发冲突

注册流程使用两层检查：

1. `assertRegistrationAvailable()` 在写入前检查邮箱和用户名，尽早返回友好提示；
2. 数据库 `@unique` 约束处理两个请求并发通过前置检查的竞态。

Prisma 抛出 `P2002` 时读取 `error.meta.target`：

| 冲突字段   | HTTP 状态 | 业务码                                 |
| ---------- | --------- | -------------------------------------- |
| `email`    | 409       | `USER_EMAIL_REGISTERED` (`20001`)      |
| `username` | 409       | `USERNAME_REGISTERED` (`20002`)        |
| 无法识别   | 409       | `USER_REGISTRATION_CONFLICT` (`20013`) |

不能仅依赖前置查询，也不能把所有 `P2002` 都误报为邮箱已注册。

## 6. 业务码分段

| 范围          | 领域               |
| ------------- | ------------------ |
| `10000-10999` | 通用请求与校验     |
| `11000-11999` | 认证与会话         |
| `20000-20999` | 用户与注册         |
| `30000-30999` | 聊天与房间         |
| `40000-40999` | 通知与好友         |
| `50000-50999` | 收藏               |
| `60000-60999` | 文件存储           |
| `70000-70999` | AI                 |
| `90000-90999` | 基础设施和未知错误 |

已发布业务码不能改变含义、重新编号或分配给其他错误。

## 7. 编码规范

Controller 只组织成功响应和必要的实时推送，不构造失败对象。Service 负责业务规则并抛出 `BusinessException`。局部 `catch` 只用于补偿、重试、ACK 协议或把第三方异常转换为领域异常。

禁止：

```ts
catch (error) {
  return { result: false, message: "服务异常" };
}
```

推荐：

```ts
throw new BusinessException(
  BusinessErrorCode.USER_EMAIL_REGISTERED,
  "该邮箱已注册，请直接登录",
  HttpStatus.CONFLICT,
);
```

新增业务失败时必须同时确认：HTTP 状态、业务码、客户端安全提示、日志内容和测试用例。

## 8. 风险与运维注意事项

- 前端必须按真实 HTTP 状态处理失败，不能只把 HTTP 200 当作唯一成功条件；
- WebSocket 客户端应读取 `code`，不能依赖中文提示做业务分支；
- 4xx 指标会比改造前增加，这是监控语义恢复正常，不是系统故障率上升；
- 仅对 429、网络错误和部分 5xx 执行自动重试，409、403 等业务错误不能盲目重试；
- 日志和告警应按 `businessCode`、HTTP 状态、WebSocket 事件和 `requestId` 聚合；
- 未知异常不能把堆栈、SQL、Redis Key、内部地址或第三方响应正文返回客户端。

## 9. 验证与剩余事项

当前使用 `pnpm build` 验证 TypeScript 编译。项目当前缺少可执行的 Jest 环境，因此异常契约仍需补充自动化测试。

建议优先覆盖：邮箱/用户名并发注册冲突、Token 过期、AI 限流与超时、敏感内容拒绝、WebSocket 业务异常和未知异常脱敏。

`TransformInterceptor` 仍暂时兼容历史 `result:false` 返回结构。现有 HTTP Controller 已不再使用该方式，后续可在客户端迁移完成后移除兼容分支。
