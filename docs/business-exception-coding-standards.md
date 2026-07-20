# 全局业务码与异常处理代码规范

## 1. 适用范围

本文定义 HTTP 接口中的成功响应、业务异常、未知异常和业务码使用规范，适用于 Controller、Service、Guard、Pipe、Interceptor 和 Exception Filter。

后台队列消费者不直接使用 HTTP 响应，但应复用相同的错误分类思想，将错误明确区分为可重试、不可重试和业务拒绝。

## 2. 设计结构

当前公共结构如下：

```text
BusinessErrorCode
  -> 定义稳定、全局唯一的业务码

BusinessException
  -> 同时携带 HTTP status、businessCode 和安全提示

ResponseFactory
  -> 统一成功和错误响应对象结构

TransformInterceptor
  -> 调用 ResponseFactory 构造成功响应

GlobalExceptionFilter
  -> 调用 ResponseFactory 构造错误响应
```

请求执行路径：

```text
正常返回
  -> TransformInterceptor
  -> HTTP 2xx
  -> code = 0

业务异常
  -> BusinessException
  -> GlobalExceptionFilter
  -> HTTP 4xx/5xx
  -> code = 具体业务码

未知异常
  -> GlobalExceptionFilter
  -> HTTP 500
  -> code = INTERNAL_ERROR
```

## 3. 设计优点

### 3.1 HTTP 语义真实

邮箱已注册返回 HTTP 409，权限不足返回 403，资源不存在返回 404，频率限制返回 429。网关、监控和客户端请求库不需要解析中文 message 才知道错误类型。

这能让以下能力保持准确：

- HTTP 4xx/5xx 成功率指标；
- API Gateway 限流和熔断；
- 客户端重试策略；
- Sentry、日志平台和告警统计；
- CDN、反向代理和缓存行为。

### 3.2 前端判断稳定

前端不再依赖可能调整或国际化的提示文本：

```ts
if (error.code === BusinessErrorCode.USER_EMAIL_REGISTERED) {
  navigateToLogin();
}
```

message 可以改变，业务码含义不能改变。

### 3.3 Controller 更轻

Controller 只负责参数接收、调用 Service 和组织成功结果，不需要了解错误响应结构：

```ts
const user = await this.userService.create(dto);
return { result: true, message: '注册成功', data: user };
```

业务失败由 Service 抛出异常，响应由 Filter 统一构造。

### 3.4 避免错误被吞掉

Controller 不再把 `ConflictException`、`ForbiddenException` 等转换成普通 HTTP 200 返回。Service 的错误语义可以完整传递到客户端。

### 3.5 响应格式一致

成功和失败都由公共 Response Factory 构造，避免不同 Controller 出现字段缺失、`data` 类型不一致或 code 语义不同。

### 3.6 便于演进和国际化

业务码可以映射到前端多语言资源，也可以在后端逐步增加 `details`、`requestId` 和文档链接，而不需要逐个修改 Controller。

## 4. 响应契约

### 4.1 成功响应

```http
HTTP/1.1 200 OK
```

```json
{
  "result": true,
  "code": 0,
  "data": {},
  "message": "操作成功"
}
```

创建资源时可以使用 HTTP 201；无响应内容时可以使用 204，但采用 204 时不能再返回 JSON body。

### 4.2 业务错误

```http
HTTP/1.1 409 Conflict
```

```json
{
  "result": false,
  "code": 20001,
  "data": null,
  "message": "该邮箱已注册，请直接登录",
  "path": "/api/users/register",
  "requestId": "request-id"
}
```

`code` 是业务码，不是 HTTP 状态。HTTP 状态从响应状态行读取。

### 4.3 未知错误

```http
HTTP/1.1 500 Internal Server Error
```

```json
{
  "result": false,
  "code": 90000,
  "data": null,
  "message": "Internal server error",
  "path": "/api/resource"
}
```

未知错误不能向客户端暴露堆栈、SQL、Redis Key、内部地址或第三方原始响应。

## 5. 分层职责规范

### Controller

应该：

- 接收经过 DTO 校验的参数；
- 从认证上下文取得当前用户；
- 调用 Service；
- 返回成功数据；
- 在必要时触发不影响事务结果的实时通知。

不应该：

- 判断 Prisma 错误码；
- 根据异常 message 拼装失败响应；
- 捕获所有异常后返回 HTTP 200；
- 重复构造 `{ result, code, data, message }` 错误对象；
- 把内部异常详情返回客户端。

### Service

应该：

- 实现业务规则；
- 查询并修改数据库；
- 抛出带明确业务码的 `BusinessException`；
- 使用数据库唯一约束处理并发竞态；
- 在跨多条记录的不变量中使用事务。

不应该：

- 返回 Controller 专用响应结构；
- 捕获业务异常后转换成 `null`；
- 使用中文 message 作为程序分支依据。

### TransformInterceptor

只处理正常返回值：

- `result=true`；
- `code=SUCCESS`；
- 统一 `data` 和 `message`。

异常不会经过 Transform，不能把错误处理逻辑只写在 Transform 中。

### GlobalExceptionFilter

负责：

- 读取 HTTP 状态；
- 读取业务码；
- 构造错误响应；
- 规范化 ValidationPipe 消息；
- 返回安全文案；
- 记录结构化错误日志。

Filter 不执行业务补偿，不查询业务数据库，也不根据 message 猜业务码。

## 6. 业务码规范

### 6.1 分段

| 范围 | 领域 |
| --- | --- |
| `10000-10999` | 通用请求与参数 |
| `11000-11999` | 鉴权与会话 |
| `20000-20999` | 用户与注册 |
| `30000-30999` | 聊天与房间 |
| `40000-40999` | 通知与好友 |
| `50000-50999` | 收藏 |
| `60000-60999` | 文件存储 |
| `70000-70999` | AI |
| `90000-90999` | 基础设施与未知异常 |

### 6.2 命名

业务码使用大写枚举名：

```ts
USER_EMAIL_REGISTERED
CHAT_NOT_ROOM_MEMBER
AI_RATE_LIMITED
```

不要使用：

```ts
ERROR_1
USER_ERROR
REGISTER_FAILED
```

名称应描述稳定原因，而不是当前页面动作或临时实现。

### 6.3 稳定性

- 已发布业务码不得改变含义。
- 已废弃业务码不得分配给其他错误。
- 一个业务原因只使用一个业务码。
- 同一业务码可以在多个入口复用，但 HTTP 状态和语义必须一致。
- 新增业务码时必须同步文档和测试。

## 7. 抛异常规范

推荐：

```ts
throw new BusinessException(
  BusinessErrorCode.USER_EMAIL_REGISTERED,
  '该邮箱已注册，请直接登录',
  HttpStatus.CONFLICT,
);
```

不推荐：

```ts
return { result: false, message: '邮箱已存在', data: null };
```

不推荐：

```ts
throw new Error('邮箱已存在');
```

普通 `Error` 会被视为未知服务端异常，返回 500。

## 8. HTTP 状态选择

| 场景 | HTTP 状态 |
| --- | ---: |
| DTO 或验证码错误 | 400 |
| 未登录或 Token 无效 | 401 |
| 没有资源操作权限 | 403 |
| 资源不存在 | 404 |
| 唯一性或状态冲突 | 409 |
| 请求频率过高 | 429 |
| 第三方上游错误 | 502 |
| 依赖未配置或暂不可用 | 503 |
| 上游超时 | 504 |

不要因为前端容易处理就把所有业务错误改成 200。

## 9. catch 规范

允许保留 catch 的场景：

```ts
try {
  await publishMessage();
} catch (error) {
  await rollbackTemporaryState();
  throw error;
}
```

```ts
try {
  await cleanupVerificationCode();
} catch (error) {
  logger.warn(...); // 主业务已经成功，清理失败不覆盖结果
}
```

禁止：

```ts
try {
  return await service.execute();
} catch (error) {
  return {
    result: false,
    message: SERVICE_ERROR_MESSAGE,
    data: null,
  };
}
```

如果保留旧 Controller catch，至少必须让 `HttpException` 继续抛出。最终目标是删除无补偿意义的 catch，让未知异常也由 Filter 返回 HTTP 500。

## 10. Prisma 唯一性竞态

注册前查询只能改善用户提示，不能保证并发安全：

```text
请求 A 查询邮箱不存在
请求 B 查询邮箱不存在
请求 A 创建成功
请求 B 创建时触发唯一约束
```

因此必须同时具备：

1. 创建前友好查询；
2. 数据库 `@unique`；
3. 捕获 Prisma `P2002`；
4. 将 `P2002` 转换为对应 `BusinessException`。

不能删除数据库唯一约束，也不能只依赖 DTO 异步校验。

## 11. 日志规范

业务 4xx：

- 记录 HTTP 状态、业务码、路径、用户 ID 和 requestId；
- 不需要全部打印错误堆栈，避免日志噪音；
- 不记录密码、验证码、Token 或聊天正文。

未知 5xx：

- 记录堆栈；
- 记录 requestId 和安全上下文；
- 客户端只返回通用文案。

## 12. 测试规范

每个新增业务码至少有一个测试，断言：

- HTTP 状态正确；
- `result=false`；
- `code` 等于业务码；
- `data=null`；
- message 是安全提示；
- 不包含堆栈和内部异常。

注册测试示例：

```text
邮箱已注册    -> HTTP 409 + code 20001
用户名已注册  -> HTTP 409 + code 20002
验证码错误    -> HTTP 400 + code 20003
注册成功      -> HTTP 2xx + code 0
```

## 13. 代码审查清单

- 是否为新业务错误分配了正确领域的业务码？
- HTTP 状态是否符合语义？
- Service 是否抛出 `BusinessException`？
- Controller 是否吞掉了异常？
- catch 是否确实执行补偿、降级或转换？
- 是否仍存在 HTTP 200 + `result=false` 的新代码？
- 是否依赖 message 文本做程序判断？
- 是否保留数据库约束作为并发兜底？
- Filter 是否会泄露内部错误？
- 文档和测试是否同步？

## 14. 当前迁移状态

已完成：

- 全局业务码文件；
- `BusinessException`；
- 公共 Response Factory；
- Transform 统一成功响应；
- Filter 统一错误响应；
- 注册邮箱、用户名和验证码业务码；
- 主要 Controller 的 `HttpException` 透传。

待逐步完成：

- 将其他领域的普通 `HttpException` 替换为具体业务码；
- 删除 Controller 中无补偿意义的 catch；
- 消除遗留的 HTTP 200 + `result=false`；
- 安装并配置 Jest/e2e 测试；
- 更新前端错误码映射。
