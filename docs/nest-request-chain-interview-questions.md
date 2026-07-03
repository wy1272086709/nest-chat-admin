# NestJS 请求链路与自定义校验器面试题

> 关联阅读：[custom-validator-guide.md](./custom-validator-guide.md)、[auth-execution-flowchart.md](./auth-execution-flowchart.md)、[jwt-auth-flow.md](./jwt-auth-flow.md)
> 覆盖范围：`class-validator` 自定义校验器、Guard、Middleware、Pipe、Interceptor、Exception Filter。

---

## 一、答题总览

Nest 面试里，这几类组件经常被放在一起问，因为它们都在请求链路里，但职责边界不同：

| 组件 | 核心职责 | 常见使用场景 |
|---|---|---|
| Middleware | 路由匹配前后的请求预处理 | requestId、日志、原始 body、简单 header 处理 |
| Guard | 决定请求能否进入路由处理器 | 登录校验、权限校验、`@Public()` 跳过鉴权 |
| Pipe | 参数转换与参数校验 | DTO 校验、`ParseIntPipe`、自定义 ID 校验 |
| Interceptor | 包裹 handler，处理前后逻辑 | 统一响应包装、耗时日志、响应映射、缓存 |
| Filter | 捕获异常并统一输出错误响应 | 全局异常格式、区分 `HttpException` 与未知异常 |
| class-validator 自定义校验器 | DTO 字段级或跨字段规则 | 两次密码一致、邮箱唯一、二选一字段 |

一个常见 HTTP 请求的大致顺序可以这样记：

```text
Middleware -> Guard -> Interceptor(before) -> Pipe -> Controller -> Service
                                       -> Interceptor(after) -> Response
异常：Pipe / Controller / Service / Interceptor 中抛出 -> Exception Filter
```

---

## 二、自定义校验器（5 题）

### 1. 请解释 `@Match('password')` 从装饰器声明到真正执行校验的完整链路。

**考察点**：装饰器、元数据、`registerDecorator`、`ValidationPipe`、`constraints`、`validate()`。

**答题要点**：

- `@Match('password')` 执行时不会立刻校验，只是通过 `registerDecorator` 注册元数据。
- 元数据包含：目标类、字段名、校验参数 `constraints: ['password']`、约束类 `MatchConstraint`。
- 请求进入 controller 前，`ValidationPipe` 触发 class-validator 扫描 DTO 实例上的校验元数据。
- 校验 `confirmPassword` 时，class-validator 调用 `MatchConstraint.validate(value, args)`。
- `value` 是当前字段值，`args.constraints[0]` 是 `'password'`，`args.object` 是整个 DTO 实例。
- `validate()` 比较 `confirmPassword` 和 `password`，返回 `true` 通过，`false` 失败。

---

### 2. `ValidationArguments` 里 `value`、`object`、`property`、`constraints` 分别是什么？跨字段校验怎么用它们？

**考察点**：能否说清楚 class-validator 给自定义约束的上下文。

**答题要点**：

- `value`：当前被校验字段的值，例如 `confirmPassword` 的值。
- `args.object`：整个 DTO 实例，可以读取其他字段，例如 `(args.object as any).password`。
- `args.property`：当前字段名，例如 `'confirmPassword'`。
- `args.constraints`：装饰器传给约束类的参数数组，例如 `@Match('password')` 对应 `['password']`。
- 跨字段校验依赖 `args.object` 读取其他字段，依赖 `constraints` 决定读取哪个字段。

---

### 3. 如果要写一个查库校验邮箱唯一性的装饰器，需要哪些关键步骤？为什么只写 `@Injectable()` 还不够？

**考察点**：异步校验、Nest DI、`useContainer`。

**答题要点**：

- 约束类加 `@ValidatorConstraint({ name: 'isUserNotExist', async: true })`。
- `validate()` 返回 `Promise<boolean>`，里面调用 `userService.findByEmail(email)`。
- 约束类加 `@Injectable()`，并通过构造函数注入 `UserService`。
- 在对应 module 的 `providers` 注册这个 constraint。
- 还需要在 `main.ts` 调用 `useContainer(app.select(AppModule), { fallbackOnErrors: true })`。
- 原因是 class-validator 默认自己创建约束类实例，不走 Nest 容器；不配置 `useContainer` 时，依赖注入可能拿不到 `UserService`。

---

### 4. DTO 层异步唯一性校验和数据库 unique 约束有什么区别？为什么不能只依赖 DTO 校验？

**考察点**：并发、竞态、最终一致性。

**答题要点**：

- DTO 异步校验适合提前给出友好错误，比如“邮箱已被注册”。
- 但它发生在写数据库之前，只代表“校验那一刻没有重复”。
- 并发请求可能同时通过 DTO 校验，然后同时写入。
- 数据库 unique 约束才是最终防线。
- 实际项目里通常两层都要有：DTO 校验负责体验，数据库约束负责一致性，Service 层负责捕获写入冲突并转换成业务错误。

---

### 5. 什么时候应该用自定义 DTO 校验器，什么时候应该把校验放到 Service 层？请举例。

**考察点**：分层边界。

**答题要点**：

- 纯格式规则适合 DTO：邮箱格式、字符串长度、枚举值。
- 简单跨字段规则适合 DTO：`confirmPassword` 必须等于 `password`、二选一字段。
- 单字段查库也可以放 DTO：邮箱是否已注册、邀请码是否存在，但要注意性能和竞态。
- 强业务上下文适合 Service：当前用户是否有权限使用优惠券、订单库存是否足够、多表事务校验。
- 判断标准：如果规则只依赖请求体字段，可以放 DTO；如果规则依赖当前登录用户、事务状态、多表一致性，优先放 Service。

---

## 三、Guard（3 题）

### 6. Guard 在 Nest 请求生命周期中负责什么？它和 Middleware、Interceptor 的边界是什么？

**考察点**：请求链路职责边界。

**答题要点**：

- Guard 决定请求是否可以进入 controller handler，返回 `true` 放行，返回 `false` 或抛异常拒绝。
- Middleware 更靠前，适合做请求预处理，不适合依赖 handler 元数据做精细权限。
- Interceptor 包裹 handler，可以处理执行前后逻辑和响应结果。
- Guard 最典型场景是认证和授权，例如 JWT 校验、角色权限校验。

---

### 7. 如何实现一个基于装饰器元数据的角色权限 Guard？`Reflector` 起什么作用？

**考察点**：`SetMetadata`、`Reflector`、handler/class metadata。

**答题要点**：

- 先定义 `@Roles('admin')` 装饰器，本质是 `SetMetadata('roles', roles)`。
- Guard 中注入 `Reflector`。
- 用 `reflector.getAllAndOverride('roles', [context.getHandler(), context.getClass()])` 读取方法和类上的元数据。
- 从 `context.switchToHttp().getRequest()` 获取 `request.user`。
- 判断 `request.user.role` 是否在需要的角色列表里。
- 没有角色元数据时可以默认放行，具体看业务策略。

---

### 8. 项目里如果有 `@Public()` 跳过 JWT 校验，你会怎么在 `JwtAuthGuard` 里实现？

**考察点**：公开路由与全局鉴权结合。

**答题要点**：

- `@Public()` 用 `SetMetadata('isPublic', true)` 标记 handler 或 controller。
- `JwtAuthGuard` 注入 `Reflector`。
- `canActivate()` 中读取 `isPublic` 元数据。
- 如果是 public，直接 `return true`。
- 否则执行 JWT 校验逻辑，比如 `return super.canActivate(context)`。
- 这样可以把 JWT Guard 设为全局，同时保留登录、注册、发送验证码等公开接口。

---

## 四、Middleware（3 题）

### 9. Middleware 适合做什么？为什么一般不把权限判断写在 Middleware 里？

**考察点**：Middleware 的位置和能力边界。

**答题要点**：

- Middleware 适合做 requestId、访问日志、基础 header 处理、原始 body 保存等。
- Middleware 运行较早，通常拿不到 controller/handler 上的装饰器元数据。
- 权限判断经常依赖 `@Public()`、`@Roles()`、当前用户等上下文，更适合 Guard。
- 把权限放 Middleware 容易绕开 Nest 的元数据系统，也不利于按 handler 精细控制。

---

### 10. Nest Middleware 和 Express Middleware 有什么关系？`next()` 忘记调用会怎样？

**考察点**：底层平台和执行模型。

**答题要点**：

- Nest 默认 HTTP 平台常用 Express，Middleware 签名也是 `(req, res, next)`。
- Middleware 可以是函数，也可以是实现 `NestMiddleware` 的类。
- 如果既不调用 `next()`，也不直接结束响应，请求会一直挂起。
- 如果 Middleware 抛异常或传递错误，会进入 Nest/底层异常处理流程，具体取决于绑定方式和平台。

---

### 11. 如何只给某些路由应用 Middleware？全局 Middleware 和模块内 Middleware 有什么区别？

**考察点**：`configure()`、`MiddlewareConsumer`。

**答题要点**：

- 在 module 里实现 `NestModule`，写 `configure(consumer: MiddlewareConsumer)`。
- 使用 `consumer.apply(LoggerMiddleware).forRoutes(UserController)` 或指定 path/method。
- 可以用 `exclude()` 排除某些路由。
- 全局 Middleware 适合所有请求都需要的逻辑，比如 requestId。
- 模块内 Middleware 更适合业务范围内的处理，比如只记录某个模块的访问日志。

---

## 五、Pipe（3 题）

### 12. Pipe 的两个核心职责是什么？`ValidationPipe` 同时做了哪两类事情？

**考察点**：转换和校验。

**答题要点**：

- Pipe 有两个核心职责：参数转换 transformation 和参数校验 validation。
- `ValidationPipe` 可以把 plain object 转成 DTO 实例，这依赖 `transform: true`。
- 它也会调用 class-validator 执行 DTO 装饰器校验。
- `whitelist: true` 会移除 DTO 未声明的字段。
- `forbidNonWhitelisted: true` 会在出现非白名单字段时直接报错。

---

### 13. 如果要写一个 `ParseObjectIdPipe` 或 `ParseCuidPipe`，应该返回什么、抛什么异常？

**考察点**：自定义 Pipe 的行为。

**答题要点**：

- 自定义 Pipe 实现 `PipeTransform`。
- 在 `transform(value, metadata)` 中检查参数格式。
- 合法时返回转换后的值或原值。
- 不合法时抛 `BadRequestException`，例如 `throw new BadRequestException('id 格式不正确')`。
- Pipe 在 controller handler 执行前运行，所以 handler 收到的一定是校验/转换后的参数。

---

### 14. DTO 校验失败后，如何统一只返回第一条错误信息？这属于 Pipe、Filter 还是 Interceptor 的职责？

**考察点**：`ValidationPipe.exceptionFactory`。

**答题要点**：

- 可以在全局 `ValidationPipe` 配置 `exceptionFactory`。
- `exceptionFactory(errors)` 接收 `ValidationError[]`。
- 从里面提取第一条 constraints message。
- 返回 `new BadRequestException(firstMessage)`。
- 这个“如何把校验错误转成异常”的动作主要属于 Pipe 的定制点。
- Filter 可以统一格式化异常响应，但第一条消息通常在 Pipe 里决定。

---

## 六、Interceptor（3 题）

### 15. Interceptor 为什么说是“包裹”路由处理器？`next.handle()` 返回的是什么？

**考察点**：Observable 和 AOP 思路。

**答题要点**：

- Interceptor 的 `intercept(context, next)` 在 handler 执行前被调用。
- 调用 `next.handle()` 才会进入后续流程和 controller handler。
- `next.handle()` 返回 RxJS `Observable`。
- 可以在 `next.handle().pipe(map(...), tap(...), catchError(...))` 中处理响应、日志和异常。
- 所以 Interceptor 像 AOP 一样包裹 handler 前后。

---

### 16. 全局响应包装 `{ result, code, data, message }` 应该用 Interceptor 还是 Filter？为什么？

**考察点**：正常流与异常流。

**答题要点**：

- 成功响应包装适合 Interceptor。
- Interceptor 能拿到 handler 正常返回值，并统一映射成 `{ result, code, data, message }`。
- 异常响应适合 Exception Filter。
- Filter 负责捕获抛出的异常，并生成统一错误结构。
- 不建议用 Filter 包正常响应，也不建议只靠 Interceptor 处理所有异常。

---

### 17. 如果要记录接口耗时和请求参数，你会放在 Middleware 还是 Interceptor？如何选择？

**考察点**：日志采集位置选择。

**答题要点**：

- 只记录请求进入时间、IP、URL，可以用 Middleware。
- 如果要记录 handler 执行耗时，Interceptor 更合适，因为它包裹 `next.handle()`。
- 如果要记录响应状态、响应体摘要，也更适合 Interceptor。
- 请求参数中有密码、token、验证码时要脱敏。
- 高并发场景日志要注意异步写入和采样，避免拖慢主链路。

---

## 七、Exception Filter（3 题）

### 18. Exception Filter 解决什么问题？和 `try/catch` 写在每个 Controller 里相比有什么优缺点？

**考察点**：全局异常治理。

**答题要点**：

- Exception Filter 用于集中捕获和格式化异常响应。
- 相比每个 controller 写 `try/catch`，全局 Filter 能减少重复代码。
- 它能统一 HTTP 状态码、错误结构、日志记录方式。
- Controller 内 `try/catch` 适合处理明确的业务分支，但滥用会导致错误流不统一。
- 更推荐 Service 抛业务异常，Filter 统一输出。

---

### 19. `HttpException` 和普通 `Error` 在 Filter 里应该如何区分处理？

**考察点**：异常分类。

**答题要点**：

- 用 `exception instanceof HttpException` 判断是否是 Nest HTTP 异常。
- 对 `HttpException`，通过 `getStatus()` 获取状态码，通过 `getResponse()` 获取响应内容。
- 对普通 `Error` 或未知异常，通常映射为 500。
- 生产环境不要把内部 stack 或数据库错误细节直接返回给前端。
- 日志里可以记录完整错误，响应里只给安全、可读的消息。

---

### 20. 如果项目同时有 TransformInterceptor 和 GlobalExceptionFilter，请说明成功响应、业务异常、DTO 校验异常分别会经过谁。

**考察点**：请求链路综合理解。

**答题要点**：

- 成功响应：Controller 正常 return，经过 TransformInterceptor 包装。
- DTO 校验异常：ValidationPipe 抛 `BadRequestException`，进入 GlobalExceptionFilter。
- Service 或 Controller 抛出的 `HttpException`：进入 GlobalExceptionFilter。
- 未知异常：进入 GlobalExceptionFilter，通常转成 500。
- 如果 Controller 自己 catch 了异常并返回 `{ result:false }`，这已经不是异常流，而是正常返回流，会继续经过 Interceptor，具体是否二次包装取决于 Interceptor 实现。

