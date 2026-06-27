# JWT 401 问题排查复盘

## 背景

接口 `POST /api/users/searchFriend` 报错：

```json
{
  "success": false,
  "code": 401,
  "path": "/api/users/searchFriend",
  "message": "Unauthorized"
}
```

这个接口本身是登录后功能，应该保留 JWT 认证，不能通过 `@Public()` 跳过认证。

## 认证链路

当前项目的 JWT 认证链路是：

1. `AppModule` 注册全局 `APP_GUARD`
2. 全局 guard 使用 `JwtAuthGuard`
3. `JwtAuthGuard` 继承 `AuthGuard('jwt')`
4. `AuthGuard('jwt')` 自动调用 `JwtStrategy`
5. `JwtStrategy.validate(payload)` 根据 `payload.sub` 查询用户

所以 `jwt.strategy.ts` 虽然没有在业务代码里显式调用，但它会被 Passport 的 JWT guard 间接调用。

## 排查过程

### 1. 先确认接口是否应该公开

一开始看到 401，先检查了 `searchFriend`：

```ts
@Post('searchFriend')
async searchFriend(@Body() searchDto: SearchDto) {}
```

它没有 `@Public()`，所以会被全局 `JwtAuthGuard` 拦截。

短暂尝试过给它加 `@Public()`，但这个判断是错误方向。因为该接口需要登录态，正确修复不是绕过认证，而是修正 JWT 认证本身。

### 2. 确认 token payload 字段

登录时签发 token 的代码在 `AuthService.login`：

```ts
const payload = {
  sub: user.id,
  email: user.email,
  username: user.username,
};

const access_token = this.jwtService.sign(payload, { expiresIn });
```

校验时读取 token 的代码在 `JwtStrategy.validate`：

```ts
const user = await this.userService.findById(payload.sub);
```

最终决定统一使用标准 JWT subject 字段 `sub`，不兼容旧的 `payload.id`。

这意味着：旧 token 如果是用 `id` 字段签发的，会因为没有 `sub` 而查不到用户，最终返回 401。解决方式是重新登录获取新 token。

### 3. 修复手动写入 `exp` 的问题

之前 token payload 里手动写过 `exp`，同时又传了 `expiresIn`：

```ts
const payload = {
  sub: user.id,
  exp: expTime,
};

this.jwtService.sign(payload, { expiresIn });
```

这会触发错误：

```txt
Bad "options.expiresIn" option the payload already has an "exp" property.
```

原因是 JWT 库不允许同时通过 payload 的 `exp` 和 sign options 的 `expiresIn` 设置过期时间。

最终保留：

```ts
this.jwtService.sign(payload, { expiresIn });
```

让 JWT 库自动生成标准的秒级 `exp`。

### 4. 修复刷新 token 的配置 key

`TokenRefreshInterceptor` 里刷新 token 时，之前读取的是：

```ts
this.configService.get('JWT_EXPIRES_IN')
```

但项目通过 `commonConfig` 暴露的是：

```ts
jwt: {
  expiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
}
```

所以正确读取方式是：

```ts
this.configService.get('jwt.expiresIn')
```

否则刷新出来的 token 可能使用错误或空的过期配置。

### 5. 增强 401 错误信息

默认 `AuthGuard('jwt')` 返回的错误信息通常只有 `Unauthorized`，不利于定位。

因此在 `JwtAuthGuard` 增加了 `handleRequest`：

```ts
handleRequest(err: any, user: any, info: any) {
  if (err) {
    throw err;
  }

  if (user) {
    return user;
  }

  if (info?.name === 'TokenExpiredError') {
    throw new UnauthorizedException('Token 已过期，请重新登录');
  }

  if (info?.name === 'JsonWebTokenError') {
    throw new UnauthorizedException('Token 无效，请重新登录');
  }

  if (info?.message === 'No auth token') {
    throw new UnauthorizedException('缺少 Authorization 请求头');
  }

  throw new UnauthorizedException(info?.message || '认证失败，请重新登录');
}
```

这样之后再遇到 401，可以直接从返回 message 判断方向。

## 最终定位的问题

最终问题不是 `jwt.strategy.ts` 没有用到，也不是 `searchFriend` 应该公开。

真正的问题是认证数据和请求状态不一致：

1. 项目最终统一使用 `payload.sub` 作为用户 ID。
2. 如果客户端还拿着旧 token，旧 token 可能没有 `sub`，只有 `id`。
3. `JwtStrategy` 用 `payload.sub` 查用户时拿到 `undefined`，查不到用户，于是返回 401。
4. 重新登录后拿到新 token，新 token 包含 `sub`，认证链路恢复正常。

同时顺手修复了两个会干扰认证的问题：

1. 登录签 token 时不再手动写 `exp`，统一交给 `expiresIn`。
2. token 自动刷新时使用正确配置 key：`jwt.expiresIn`。

## 当前约定

JWT payload 统一格式：

```ts
{
  sub: user.id,
  email: user.email,
  username: user.username,
  iat: number,
  exp: number
}
```

其中：

- `sub`：用户 ID，业务侧查用户只认这个字段
- `iat`：JWT 库自动生成
- `exp`：JWT 库根据 `expiresIn` 自动生成

请求受保护接口时，必须带：

```http
Authorization: Bearer <access_token>
```

## 以后遇到 401 的排查顺序

1. 看接口是否应该公开。
   - 登录、注册、发送验证码、忘记密码这类接口可以 `@Public()`。
   - 用户资料、好友搜索、登出等登录后功能不应该 `@Public()`。

2. 看请求头是否正确。
   - 必须是 `Authorization`
   - 值必须是 `Bearer token`
   - `Bearer` 和 token 中间必须有空格

3. 看返回 message。
   - `缺少 Authorization 请求头`：前端没传 token
   - `Token 已过期，请重新登录`：重新登录
   - `Token 无效，请重新登录`：token 格式、签名或 secret 不对
   - `用户不存在`：token 里的 `sub` 查不到用户

4. 看 token payload。
   - 确认 payload 里有 `sub`
   - 不再使用 `id` 作为 JWT 用户 ID 字段

5. 看配置。
   - 签发和校验必须使用同一个 `jwt.secret`
   - 过期时间统一使用 `jwt.expiresIn`

## 注意事项

修改 JWT payload 结构后，旧 token 应视为失效，需要客户端重新登录。

如果服务端代码已经修改，但接口返回还是旧错误信息，需要重启 Nest 服务，确保运行的是最新代码。
