# Controller 异常吞噬问题复盘与全局业务码设计

团队落地时的具体编码规则和审查清单见 [business-exception-coding-standards.md](./business-exception-coding-standards.md)。

## 1. 问题背景

项目已经注册全局 `GlobalExceptionFilter`，但多个 Controller 又使用 `try/catch`，并把所有异常转换为普通失败对象：

```ts
return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
```

这会导致 Service 抛出的 400、403、404、409、429 等 `HttpException` 无法到达全局 Filter。Nest 会把 Controller 返回值当成正常请求，再由成功拦截器包装成 HTTP 200。

典型因果链：

```text
Service 检查到邮箱已注册
  -> 抛出 ConflictException
  -> Controller catch 捕获
  -> 返回 SERVICE_ERROR_MESSAGE
  -> TransformInterceptor 按成功返回处理
  -> HTTP 200
  -> GlobalExceptionFilter 没有执行机会
```

结果是客户端无法区分业务冲突和基础设施故障，HTTP 监控数据也会失真。

## 2. 当前修复

本次检查覆盖 `UserController`、`ChatController`、`NotificationController`、`FavoriteController` 和 `MinioController`。

当前处理规则：

- `HttpException` 继续抛出，由全局 Filter 设置真实状态码和统一响应。
- 未知异常暂时保留旧的 `SERVICE_ERROR_MESSAGE` 兜底。
- 注册可用性由 `UserService.assertRegistrationAvailable()` 判断。
- 邮箱或用户名重复抛 409，验证码错误抛 400。
- 数据库唯一约束 `P2002` 继续处理并发注册竞态。

修复后的响应示例：

```http
HTTP/1.1 409 Conflict
```

```json
{
  "result": false,
  "code": 409,
  "data": null,
  "message": "该邮箱已注册，请直接登录",
  "path": "/api/users/register"
}
```

## 3. try/catch 的正确边界

长期应删除 Controller 中只用于统一兜底或打印日志的 `try/catch`。全局 Filter 已经负责 HTTP 异常日志和安全响应。

局部 `catch` 只适合：

- 执行业务补偿，例如邮件任务发布失败后删除 Redis 验证码。
- 错误不影响主结果，例如注册成功后清理验证码失败只记警告。
- 把第三方异常转换为明确领域异常后继续抛出。
- 后台消费者决定 ACK、Retry 或 DLQ。

仅为了返回 `SERVICE_ERROR_MESSAGE` 而捕获异常，会绕过全局 Filter，不应该保留。

目前部分 Controller 对未知异常仍保留旧的 HTTP 200 失败响应，这是兼容旧客户端的过渡行为。彻底统一时应让未知异常也进入 Filter，并返回 HTTP 500。

## 4. HTTP 状态与业务码应分开

HTTP 状态表达协议层类别，用于网关、监控、缓存和重试：

- 400：请求参数或验证码错误。
- 401：未认证或 Token 失效。
- 403：已认证但没有权限。
- 404：资源不存在。
- 409：资源状态或唯一性冲突。
- 429：请求过于频繁。
- 500/502/503/504：服务端或依赖异常。

业务码表达稳定、具体的领域原因，用于前端分支、埋点和国际化。例如 HTTP 409 可能表示邮箱已注册、用户名占用、好友申请已存在或消息幂等 ID 冲突。

不要所有错误都返回 HTTP 200，也不要让业务码替代 HTTP 状态。

## 5. 推荐响应结构

成功：

```json
{
  "result": true,
  "code": 0,
  "data": {},
  "message": "操作成功"
}
```

错误响应：

```json
{
  "result": false,
  "code": 20001,
  "data": null,
  "message": "该邮箱已注册，请直接登录",
  "path": "/api/users/register",
  "requestId": "..."
}
```

HTTP 状态通过响应状态行表达，响应体中的 `code` 是稳定业务码。迁移前端时不能再把 `code` 当成 HTTP 状态；如果需要兼容旧客户端，可以临时额外返回 `httpStatus` 字段，但不应让两个字段长期承担相同语义。

## 6. 业务码分段建议

| 范围 | 领域 | 示例 |
| --- | --- | --- |
| `10000-10999` | 通用请求 | 参数错误、资源不存在 |
| `11000-11999` | 鉴权与会话 | Token 过期、账号禁用 |
| `20000-20999` | 用户与注册 | 邮箱已注册、用户名占用 |
| `30000-30999` | 聊天与房间 | 非房间成员、消息冲突 |
| `40000-40999` | 通知与好友 | 申请已存在、通知已处理 |
| `50000-50999` | 收藏 | 收藏已存在、目标不存在 |
| `60000-60999` | 文件存储 | 文件不存在、上传失败 |
| `70000-70999` | AI | 限流、审核拒绝、模型超时 |
| `90000-90999` | 基础设施 | 数据库、Redis、MQ 不可用 |

首批可以定义：

```ts
export enum BusinessErrorCode {
  VALIDATION_FAILED = 10001,
  AUTH_TOKEN_EXPIRED = 11001,
  USER_EMAIL_REGISTERED = 20001,
  USERNAME_REGISTERED = 20002,
  VERIFICATION_CODE_INVALID = 20003,
  CHAT_NOT_ROOM_MEMBER = 30001,
  CHAT_MESSAGE_ID_CONFLICT = 30002,
  AI_RATE_LIMITED = 70001,
  AI_MODERATION_REJECTED = 70002,
  INTERNAL_ERROR = 90000,
}
```

业务码一旦发布，不应复用或改变含义。废弃码应保留记录，不能重新分配。

## 7. BusinessException 设计

建议增加统一领域异常：

```ts
export class BusinessException extends HttpException {
  constructor(
    readonly businessCode: BusinessErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ businessCode, message, details }, status);
  }
}
```

业务 Service 只声明原因，不拼 HTTP 响应：

```ts
throw new BusinessException(
  BusinessErrorCode.USER_EMAIL_REGISTERED,
  '该邮箱已注册，请直接登录',
  HttpStatus.CONFLICT,
);
```

Filter 统一读取 `status`、`businessCode` 和安全文案。Controller 不需要知道错误响应结构。

## 8. GlobalExceptionFilter 职责

Filter 应负责：

- 设置真实 HTTP 状态。
- 输出统一错误结构。
- 提取业务码和安全提示。
- 规范化 class-validator 的数组消息。
- 附带 `path` 和 `requestId`。
- 对未知异常返回通用文案。
- 记录状态码、业务码和异常类型。

Filter 不应：

- 暴露堆栈、数据库错误或第三方响应正文。
- 根据错误 message 字符串猜业务码。
- 把所有异常转换成 HTTP 200。
- 执行业务补偿或数据库回滚。

## 9. SERVICE_ERROR_MESSAGE 的边界

`SERVICE_ERROR_MESSAGE` 只适合未知服务端异常，例如数据库连接中断、未知编程错误和未归类第三方 SDK 异常。

以下情况不应使用统一系统错误：

- 邮箱或用户名已注册。
- 验证码错误。
- 用户不是房间成员。
- 资源不存在。
- 请求频率过高。
- 账号被禁用。

这些都应使用明确 HTTP 状态和业务码。

## 10. 影响范围

业务异常恢复真实 HTTP 状态后：

- 前端和 Electron IPC 不能只根据 HTTP 200 判断业务成功。
- 监控中的 4xx 数量会增加，这是数据恢复真实语义，不是服务质量下降。
- 自动重试只能覆盖网络错误、429 和部分 5xx，不能重试所有非 200。
- 调用方需要读取响应体中的业务码决定提示和交互。
- Swagger 和 API 文档应补充 400/403/404/409/429 响应。

## 11. 测试矩阵

| 场景 | HTTP 状态 | 业务码建议 |
| --- | ---: | ---: |
| 邮箱已注册 | 409 | 20001 |
| 用户名已注册 | 409 | 20002 |
| 验证码错误 | 400 | 20003 |
| 非房间成员 | 403 | 30001 |
| 消息幂等 ID 冲突 | 409 | 30002 |
| AI 请求限流 | 429 | 70001 |
| AI 审核拒绝 | 403 | 70002 |
| 未知异常 | 500 | 90000 |

每个测试同时断言 HTTP 状态、`result=false`、业务码、安全文案、`data=null`，并确认响应不包含堆栈和内部错误详情。

## 12. 推荐实施顺序

1. 让所有 `HttpException` 正确到达 Filter。
2. 删除 Controller 中没有补偿意义的 `try/catch`。
3. 使用 `BusinessErrorCode` 和 `BusinessException`。
4. 前端错误映射改为读取响应体业务码，HTTP 状态只负责协议层判断。
5. 增加 Controller/e2e 测试。
6. 逐步把剩余旧的普通 `{ result: false }` 返回改成业务异常，最终消除 HTTP 200 错误响应。

## 13. 当前验证情况

- `pnpm build` 已通过。
- `git diff --check` 已通过。
- `pnpm test -- --runInBand` 未能运行：项目声明了 Jest 脚本，但当前依赖没有安装 `jest`，也没有完整测试配置。
- 本地 `GlobalExceptionFilter` 冒烟测试通过：BusinessException 会返回 HTTP 409，响应体 `code=20001`。

因此目前只能确认编译和静态契约，不能声称异常状态码自动化测试已经通过。落地业务码时应同时补 Jest 或 e2e 测试基础设施。
