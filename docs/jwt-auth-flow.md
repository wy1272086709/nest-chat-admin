# JWT 认证流程说明

## 这篇文档解决什么问题

这篇只解释 NestJS 里 JWT 认证链路是怎么跑起来的，尤其是：

- `JwtAuthGuard.canActivate()` 什么时候执行
- `AuthGuard('jwt')` 是什么
- `JwtStrategy.validate(payload)` 什么时候执行
- 为什么代码里没有显式调用 `JwtStrategy`，它却会生效

401 问题复盘见：

```txt
docs/auth-401-debug-retrospective.md
```

## 当前项目的认证入口

项目在 `AppModule` 里注册了全局 guard：

```ts
{
  provide: APP_GUARD,
  useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector),
  inject: [Reflector],
}
```

所以请求进来以后，默认都会先经过 `JwtAuthGuard`。

只有被 `@Public()` 标记的接口会跳过 JWT 校验。

## `JwtAuthGuard.canActivate()` 做了什么

当前 guard 的核心逻辑是：

```ts
canActivate(context: ExecutionContext) {
  const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
    context.getHandler(),
    context.getClass(),
  ]);

  if (isPublic) {
    return true;
  }

  return super.canActivate(context);
}
```

这段可以分成两步理解：

1. 先检查当前接口有没有 `@Public()`
2. 如果没有，就执行 `super.canActivate(context)` 进入 Passport 的 JWT 认证流程

`JwtAuthGuard` 自己并不直接解析 token，也不直接调用 `JwtStrategy.validate()`。

真正触发 `JwtStrategy` 的地方是：

```ts
return super.canActivate(context);
```

## `AuthGuard('jwt')` 是什么

`JwtAuthGuard` 继承自：

```ts
AuthGuard('jwt')
```

这里的 `'jwt'` 是 Passport strategy 的名字。

意思是：这个 guard 要使用名为 `jwt` 的认证策略。

当前项目里的 `JwtStrategy` 是：

```ts
export class JwtStrategy extends PassportStrategy(Strategy) {}
```

这里没有手动指定 strategy 名称，所以 `passport-jwt` 默认注册名就是 `'jwt'`。

因此下面两者是对应的：

```ts
AuthGuard('jwt')
```

```ts
PassportStrategy(Strategy)
```

## 完整执行流程

### 公开接口

如果接口有 `@Public()`：

```txt
客户端请求进入
  ↓
AppModule 里的 APP_GUARD 生效
  ↓
执行 JwtAuthGuard.canActivate(context)
  ↓
检查当前 controller / handler 有没有 @Public()
  ↓
发现有 @Public()
  ↓
return true
  ↓
跳过 JWT 校验
  ↓
进入 controller 方法
```

例如登录接口、注册接口、发送验证码接口，通常应该是这种流程。

### 需要登录的接口

如果接口没有 `@Public()`：

```txt
客户端请求进入
  ↓
AppModule 里的 APP_GUARD 生效
  ↓
执行 JwtAuthGuard.canActivate(context)
  ↓
检查当前 controller / handler 有没有 @Public()
  ↓
没有 @Public()
  ↓
执行 super.canActivate(context)
  ↓
进入 Nest Passport 的 AuthGuard('jwt')
  ↓
Passport 根据 'jwt' 找到 JwtStrategy
  ↓
JwtStrategy 使用 ExtractJwt.fromAuthHeaderAsBearerToken()
  ↓
从 Authorization: Bearer <token> 里取 token
  ↓
校验 token 签名
  ↓
校验 token 是否过期
  ↓
校验通过后解析出 payload
  ↓
调用 JwtStrategy.validate(payload)
  ↓
validate 根据 payload.sub 查询用户
  ↓
查到用户后 return user
  ↓
Nest/Passport 把 user 挂到 request.user
  ↓
进入 controller 方法
```

## `JwtStrategy.validate(payload)` 什么时候执行

`validate(payload)` 不是认证流程一开始就执行。

它执行之前，Passport 已经做了这些事：

1. 从请求头取 token
2. 校验 token 格式
3. 校验 token 签名
4. 校验 token 是否过期
5. 解析 token payload

这些都通过以后，才会调用：

```ts
async validate(payload: any) {
  const user = await this.userService.findById(payload.sub);
  if (!user) {
    throw new UnauthorizedException('用户不存在');
  }
  return user;
}
```

所以 `validate()` 更准确地说，是项目自己的“用户有效性校验”。

它不是负责检查 JWT 签名的地方。

## `request.user` 是哪里来的

`JwtStrategy.validate(payload)` 返回的对象会被 Passport 挂到请求对象上：

```ts
return user;
```

之后 controller 里就可以通过：

```ts
@Request() req
```

拿到：

```ts
req.user
```

项目里的 `@CurrentUser()` 装饰器，本质上也是从请求上下文里取当前用户。

当前项目的 `TokenRefreshInterceptor` 不应该再手动写入 `request.user`。

原因是认证已经由 `JwtAuthGuard` / `JwtStrategy` 完成，`request.user` 应该以 `validate()` 返回的数据库用户为准。刷新 token 的拦截器只负责在 token 快过期时设置新的响应头，不负责认证，也不负责覆盖当前用户。

## 当前项目的 token payload 约定

登录时签发 token：

```ts
const payload = {
  sub: user.id,
  email: user.email,
  username: user.username,
};

const access_token = this.jwtService.sign(payload, { expiresIn });
```

认证时读取：

```ts
const user = await this.userService.findById(payload.sub);
```

也就是说，项目统一用：

```ts
payload.sub
```

作为 JWT 里的用户 ID。

不要再使用：

```ts
payload.id
```

如果 token 是旧版本签出来的，里面没有 `sub`，就需要重新登录获取新 token。

## 显式使用 `AuthGuard('jwt')`

`AuthGuard('jwt')` 也可以显式加在 controller 或方法上：

```ts
@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UserController {}
```

或者：

```ts
@Post('searchFriend')
@UseGuards(AuthGuard('jwt'))
async searchFriend() {}
```

但当前项目已经使用了全局 `APP_GUARD`。

所以项目推荐写法是：

```ts
@Post('searchFriend')
async searchFriend() {}
```

表示需要登录。

```ts
@Post('login')
@Public()
async login() {}
```

表示公开访问。

如果再到处手动加 `@UseGuards(AuthGuard('jwt'))`，功能上可以，但会和全局 guard 重复，代码风格会变乱。

## 一句话总结

`JwtAuthGuard.canActivate()` 是入口。

`super.canActivate(context)` 会进入 Passport。

`AuthGuard('jwt')` 会根据 `'jwt'` 找到 `JwtStrategy`。

JWT 签名和过期校验通过后，才会执行 `JwtStrategy.validate(payload)`。

`validate()` 返回的用户会成为 `request.user`。
