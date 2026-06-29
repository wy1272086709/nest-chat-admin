# 复盘：ChatFriendship 表结构不一致导致的全链路报错

> 日期：2026-06-29
> 影响范围：好友相关接口（加好友、好友列表、处理好友申请）出现 TS 编译错误 + 运行时 500
> 结论：`schema.prisma` 与「生成产物 / 迁移文件 / 真实数据库」三者脱节；根因是对 `prisma generate` 作用的误解。

---

## 一、现象（按出现顺序）

排查过程中依次冒出三类错误，看似无关，实则同源：

1. **TS 编译错误**
   ```
   error TS2353: 'userAId_userBId' does not exist in type 'ChatFriendshipWhereUniqueInput'.
   error TS2353: 'userAId' does not exist in type '...ChatFriendshipCreateInput'.
   ```
   出现在 `notification.service.ts` 与 `user.service.ts`。

2. **运行时错误**
   ```
   The table `public.chat_friendships` does not exist in the database.
   ```

3. **全局响应拦截器 500**
   ```
   GET /api/users/friends - 500
   TypeError: Cannot read properties of null (reading 'result')
       at transform.interceptor.ts:42
   ```

   > ⚠️ **后续补充（2026-06-29）**：同样的报错后来再次出现，但根因不是 stale `dist/`，而是 **`@Get(':id')` 路由遮蔽了 `friends`/`groups`**——重启并不能修复。详见 [postmortem-users-friends-route-shadowing.md](./postmortem-users-friends-route-shadowing.md)。两者的共同放大器都是「拦截器对 `null` 没有兜底」（本文「七.5」的建议已在那次一并落地）。

---

## 二、根因：四个东西必须对齐，少一个就炸

Prisma 体系里有四样东西，它们必须时刻保持一致：

```
schema.prisma  ──① generate──▶  Prisma Client(TS 类型)  ──③ 被──▶  业务代码
     │                                                            │
     │  ② 应当一致（本 bug 就断在这里）                            │ 代码用的字段名
     ▼                                                            ▼
迁移文件(.sql) ──④ deploy/push──▶  真实数据库里的表
```

| 组件 | 本 case 里的内容 | 来源 |
|---|---|---|
| `schema.prisma` | `senderId` / `receiverId` | 被人改过名 |
| 生成产物 Client | `senderId` / `receiverId` | 跟着 schema（①） |
| 业务代码 | 原本写 `userAId` / `userBId` | 跟着**旧的** Client |
| 迁移文件 SQL | `userAId` / `userBId` | 建表时生成的，没跟着改 |
| 真实数据库 | （一度）只有 `userAId` / `userBId`，甚至表都没有 | 跟着**旧的**迁移/push |

ChatFriendship 模型最早是用 `userAId/userBId` 定义的（迁移文件 `20260626000000` 就是这么建的表）。后来有人把它重构成 `senderId/receiverId`（为了和 `Notification` 模型命名统一），并执行了 `prisma generate`。于是：

- ① Client 知道了新名字 → 用旧名字的代码 **编译报错**（现象 1）。
- ② 迁移文件没人更新 → 还停在旧名字，和 schema 脱节。
- ④ 数据库没有跟着同步到位 → Client 用新名字去查，表/列对不上 → **运行时报错**（现象 2）。
- 旧编译产物（`dist/`）还在内存里跑 → 返回了 `null`，响应拦截器 `data.result` 崩溃 → **500**（现象 3）。

---

## 三、为什么"我跑过 `prisma generate` 了"还是报错？（核心误区）

> 这是最关键的一点：**`prisma generate` 只更新 TypeScript Client，完全不碰数据库。**

三条命令别再混淆：

| 命令 | 改什么 | 改数据库吗 |
|---|---|---|
| `prisma generate` | 重新生成 `@prisma/client` 的 TS 类型 | ❌ **不连数据库** |
| `prisma db push` | 把 schema **直接同步**到数据库 | ✅ 改库，但不留迁移记录 |
| `prisma migrate dev` | 生成迁移文件 **并** 应用到库 + 重新 generate | ✅ 改库，留迁移记录 |

所以改名后只跑 `generate`，等于只把 **①** 对齐了，**②④** 依然是旧的——Client 拿着新名字去问还是旧结构的数据库，必然报错。

> 补充：`npx prisma db generate` 这个命令**并不存在**（会报 Unknown command）。可能是把 `prisma generate` 和 `prisma db push` 记混了。无论记成哪个，结论都一样：**只 generate 不 push/migrate，数据库不会变。**

---

## 四、为什么 `migrate deploy` 失败（P3005）——又一个混用坑

尝试用迁移文件部署时报：

```
Error: P3005  The database schema is not empty.
```

`prisma migrate status` 显示**两个迁移都"未应用"**，但库里明明有其它表。这说明：

- 这个远程库（`47.122.112.109/app_db`）**从来不是用迁移管理的**，而是用 `prisma db push` 维护的。
- `db push` 不写 `_prisma_migrations` 表，所以迁移文件在这套库里是"孤儿"——存在，但从没被记录/应用过。
- 既留着一堆迁移文件、又用 `db push` 管库，**两种 schema 演进策略混用**，是本次排查最大的迷惑来源。

---

## 五、修复过程

1. **代码层**：把 `notification.service.ts`、`user.service.ts` 里残留的 `userAId/userBId`、`userAId_userBId` 改成 `senderId/receiverId`、`senderId_receiverId`，与 Client 对齐。
2. **迁移文件层**：把 `20260626000000_add_chat_friendships/migration.sql` 里的 `userAId→senderId`、`userBId→receiverId`（含列、唯一索引、外键名）改掉，让迁移文件和 schema 自洽。
3. **数据库层**：
   - `migrate deploy` → P3005（库非迁移管理，预期内）。
   - `prisma db push` → `The database is already in sync`（库其实已经是对的结构）。
   - 用项目自带 Client 实测 `chatFriendship.count()` → 返回 1，列为 `id, senderId, receiverId, createdAt`，**运行时链路已通**。
4. **进程层**：重启 `nest start --watch`，清掉跑着旧 `dist/` 的残留进程（现象 3 的 500 就是它造成的）。

---

## 六、当前状态（已验证）

- ✅ `schema.prisma` ↔ Client ↔ 数据库 三者一致（`senderId/receiverId`）。
- ✅ 业务代码使用 `senderId_receiverId`，TS 无报错。
- ✅ 运行时 `chatFriendship` 查询正常。
- ⚠️ 迁移文件虽已改对，但**此库不靠迁移管理**（靠 `db push`）。迁移文件目前只是"自洽的存档"，并未被这套库应用。

---

## 七、预防与规范（请团队约定）

1. **改 `schema.prisma` 后，两件事都要做**：
   - `prisma generate` 更新 Client；
   - `prisma db push`（或 `migrate dev`）更新数据库。
   - 二者缺一不可，别再以为 generate 能搞定数据库。

2. **schema 演进策略二选一，不要混用**：
   - **A. 迁移制（推荐，尤其多人/上生产）**：`prisma migrate dev` 生成可审查、可回滚、可部署的迁移文件；线上用 `prisma migrate deploy`。迁移文件就是事实来源。
   - **B. push 制（原型/单人）**：`prisma db push` 直接同步，不留历史。
   - **本 bug 的根因之一就是混用**：用 push 管库，却留着一堆没对齐的迁移文件，互相误导。

3. **迁移文件就是事实来源（若采用 A）**：改完 schema 必须 `migrate dev` 生成**新**迁移，**不要手改已应用过的旧迁移**（会触发 checksum drift）。只有在确认"从未应用"时才能改——本次正是因为该迁移从没在这套库应用过，手改才安全。

4. **排查运行时报错时先重启 dev server**：`nest start --watch` 偶尔会跑着旧 `dist/`，让你误判。本次现象 3 的 500 就是 stale 产物，重启即消失。

5. **响应拦截器应做空值兜底**（可选改进）：`TransformInterceptor` 假设所有 handler 都返回 `{ result, data, message }`，一旦某个 handler 返回 `null`，拦截器自身就会抛 500，掩盖真实错误。建议对 `data` 做 null-safe 处理，避免拦截器从"保护者"变成"肇事者"。
