# 复盘：`@Get(':id')` 路由遮蔽导致 `/api/users/friends` 返回 500

> 日期：2026-06-29
> 影响范围：`GET /api/users/friends`、`GET /api/users/groups` 等静态子路由全部被动态参数路由 `:id` 吞掉，返回 500。
> 结论：NestJS 按路由**声明顺序**注册，Express 匹配第一个命中的路由。`@Get(':id')` 声明在 `@Get('friends')` / `@Get('groups')` **之前**，导致 `friends` 被当成 `id` 解析；`findById('friends')` 返回 `null`，响应拦截器在 `null` 上读 `.result` 崩溃。
> 关联文档：[postmortem-chat-friendship-schema-drift.md](./postmortem-chat-friendship-schema-drift.md)（其「现象 3」是**同一个报错**，但本次根因不同，见下文「与上次复盘的关系」）。

---

## 一、现象

```
[Nest] ERROR [GlobalExceptionFilter] GET /api/users/friends - 500 - Internal server error
TypeError: Cannot read properties of null (reading 'result')
    at transform.interceptor.ts:43:24
    at .../rxjs/operators/map.ts
```

- 报错栈定位在 `TransformInterceptor` 的 `map` 里 `data.result` 这一行。
- 说明流入拦截器的 `data` 是 `null`。
- 但 `getFriends` 控制器在 `try` / `catch` 两个分支都返回的是 `{ message, result, data }` 对象，**理论上不可能是 `null`**。

→ 这是关键矛盾点：控制器明明返回对象，拦截器却收到 `null`。顺着这个矛盾往下查，才找到了真正的根因。

---

## 二、根因：路由声明顺序导致静态路由被 `:id` 遮蔽

### 2.1 当时的声明顺序（有 bug）

```ts
@Controller('users')
export class UserController {
  @Get()           // GET /users
  async findAll() { ... }

  @Get(':id')      // ← 第 36 行，声明得太靠前
  async findById(@Param('id') id) { return this.userService.findById(id); }

  // ...中间一堆 @Post...

  @Get('friends')  // ← 第 332 行，声明在 ':id' 之后
  async getFriends() { ... }

  @Get('groups')   // ← 第 353 行，同样被遮蔽
  async getGroups() { ... }
}
```

### 2.2 NestJS 的路由匹配规则

NestJS 底层用 Express（或 Fastify），**按装饰器在类里出现的顺序**逐个注册路由。请求进来时，Express **按注册顺序**匹配，命中第一个就返回。

于是：

```
GET /api/users/friends
        │
        ▼
1. @Get()        → /users              ❌ 不匹配（路径是 /users/friends）
2. @Get(':id')   → /users/:id          ✅ 命中！id = "friends"   ← 在这里就被截胡了
3. @Get('friends')→ /users/friends      ⛔ 永远到不了
```

`friends` 被当作 `id` 传进了 `findById('friends')`。

### 2.3 `null` 是怎么来的

```ts
async findById(id: string): Promise<ChatUser | null> {
  return this.prisma.chatUser.findUnique({ where: { id } });  // id="friends" 查无此人 → null
}
```

`findUnique` 查不到记录返回 `null`。控制器原样 `return null`。

### 2.4 拦截器为什么会 500

```ts
// transform.interceptor.ts（修复前）
return next.handle().pipe(
  map((data) => ({           // data === null
    result: data.result,     // 💥 null.result → TypeError
    code: 0,
    data: data.data,
    message: data?.message,
  }))
);
```

拦截器假定**每个 handler 都返回 `{ result, data, message }`**。一旦某个 handler 返回 `null`/`undefined`，拦截器自己就先抛了，再被 `GlobalExceptionFilter` 兜成 500。

> 同样的 `groups` 路由也被遮蔽，只是它有 `Array.isArray(result) ? result : []` 兜底，症状可能不一样，但根因相同。

---

## 三、与上次复盘的关系（同一个报错，不同的根因）

[postmortem-chat-friendship-schema-drift.md](./postmortem-chat-friendship-schema-drift.md) 的「现象 3」记录了**逐字相同**的错误：

```
GET /api/users/friends - 500
TypeError: Cannot read properties of null (reading 'result')
```

那次把它归因为「跑着旧 `dist/` 的残留进程」+ Prisma schema 命名漂移，结论是「重启即消失」。

本次需要补充/修正两点：

| 维度 | 上次复盘（schema drift） | 本次复盘（route shadowing） |
|---|---|---|
| `null` 的来源 | Prisma 查询因 schema 不一致返回 `null` | **路由被 `:id` 截胡**，`findById('friends')` 返回 `null` |
| 重启能否修复 | 当时声称可以 | **不能**——路由声明顺序是代码问题，重启不会改变匹配顺序 |
| 根本放大器 | 同一个：**拦截器对 `null` 没有兜底** | 同一个 |

换句话说：**「控制器返回 `null`」是这个症状的近因，「拦截器把 `null` 放大成 500」是共同的放大器。** 上次 `null` 来自 schema，这次 `null` 来自路由遮蔽。上次复盘「七.5」里建议的「拦截器做空值兜底」正是本次一并落地的修复——它能把这一整类问题彻底关掉。

---

## 四、修复

两处改动，都已通过 `tsc --noEmit` 校验：

### 4.1 主修复：调整路由声明顺序（[user.controller.ts](../src/user/controllers/user.controller.ts)）

把 `@Get(':id')` 从控制器顶部挪到**最末尾**，确保所有静态子路由（`friends` / `groups` / 未来新增的）都在它之前声明：

```
@Get()            GET /users
@Post('register') ...
...
@Get('friends')   GET /users/friends   ← 现在能正确命中
@Get('groups')    GET /users/groups    ← 现在能正确命中
@Get(':id')       GET /users/:id       ← 兜底，放最后
```

并在原位置留注释说明原因，避免以后有人再把 `:id` 挪到前面。

### 4.2 兜底修复：拦截器空值安全（[transform.interceptor.ts](../src/common/core/interceptors/transform.interceptor.ts)）

```ts
map((data) => {
  const wrapped =
    data && typeof data === 'object' && 'result' in data
      ? (data as DataResult<T>)
      : ({ result: true, data } as DataResult<T>);  // 未按规范包装的返回值兜底成成功
  return { result: wrapped.result, code: 0, data: wrapped.data, message: wrapped.message };
})
```

这样即使将来某个 handler 忘了按 `{ result, data, message }` 包装、或返回 `null`，拦截器也不会再把可恢复的情况变成 500。顺带移除了遗留的 `console.log('data', data)`。

---

## 五、预防与规范

1. **动态参数路由（`:id` 等）一律放在控制器最后声明。**
   - 静态段（`friends`、`groups`）必须排在参数段（`:id`）之前。
   - 这是 Express 系框架的通用规则，NestJS 不会自动按「更具体优先」排序。

2. **新增静态子路由前，扫一眼控制器里有没有靠前的 `:id` / `:xxx`。**
   - 若有，要么把新路由声明在它之前，要么评估是否该用更明确的路径前缀（如 `@Controller('users/:id/profile')` 之类）。

3. **`GET /users/<word>` 命中 `findById` 且返回 `null`，是路由遮蔽的典型信号。**
   - 排查时若发现「该走 A 接口却走了 `findById`」「`id` 参数是一个普通单词」，第一时间怀疑路由顺序。

4. **响应拦截器不要假设 handler 的返回形状。**
   - 拦截器是「保护者」，不能因为 handler 返回不规范就自己先崩。对 `null` / 非对象做兜底，让它从「放大器」变回「保护者」。（与上次复盘「七.5」一致，本次已落地。）

5. **排查 500 时先确认「请求到底走了哪个 handler」。**
   - 报错栈只告诉你最后崩在哪，不告诉你路由被谁截胡。在控制器入口加临时日志、或对比 `id` 参数值，能快速定位遮蔽问题。
