# 收藏接口 P2022 故障复盘

## 1. 问题现象

请求收藏列表时报错：

```text
PrismaClientKnownRequestError: The column `chat_favorites.type` does not exist in the current database.
code: P2022
```

触发接口：

```http
GET /api/favorites?type=VIDEO&take=20
```

出错位置：

```ts
this.prisma.favorite.findMany(...)
```

## 2. 直接原因

代码里的 Prisma schema 已经升级到新版收藏模型：

- `Favorite.type`
- `Favorite.sourceType`
- `Favorite.sourceId`
- `Favorite.sourceName`
- `Favorite.roomId`
- `Favorite.title`
- `Favorite.content`
- 媒体快照字段
- `Favorite.collectedAt`

但当前 PostgreSQL 里的真实表 `chat_favorites` 仍是旧结构，没有 `type` 列。

Prisma Client 是按当前 `schema.prisma` 生成的，所以执行 `findMany` 时会查询 `chat_favorites.type`。数据库没有这列，于是抛出 `P2022`。

## 3. 根因

数据库真实结构和 Prisma 迁移历史脱节。

排查时执行：

```bash
pnpm exec prisma migrate status
```

发现数据库里这 3 条迁移都没有被 Prisma 标记为已应用：

```text
20260626000000_add_chat_friendships
20260626000001_add_chat_clear_states
20260705000000_extend_chat_favorites
```

但真实数据库中相关表已经存在，说明这个库大概率曾经通过以下方式之一改过结构：

- 手工 SQL
- `prisma db push`
- 直接导入过部分表结构
- 迁移文件后补/后改，但没有在当前数据库上执行

因此，代码层已经认为收藏表是新版，数据库层还停留在旧版。

## 4. 修复思路

这类问题不能只改业务代码兜底。

原因是 Prisma 查询发生在 SQL 生成层，只要 Prisma Client 认为模型有 `type` 字段，就会在查询中引用该列。数据库缺列时，任何访问 `Favorite` 的正常查询都可能继续报 `P2022`。

正确修复路径是：

1. 补齐数据库表结构，让 `chat_favorites` 与 `schema.prisma` 对齐。
2. 修正 Prisma 迁移记录，让后续部署不会重复执行旧迁移。
3. 保留 repair SQL，便于其他环境遇到同类迁移脱节时复用。

## 5. 本次改动

新增修复脚本：

```text
prisma/repairs/20260710_fix_chat_favorites_schema.sql
```

这个脚本做了这些事：

- 确保 `FavoriteType` enum 存在。
- 确保 `chat_favorites` 表存在。
- 给旧表补齐新版收藏字段，包括 `type`、来源字段、展示快照字段、`collectedAt` 等。
- 如果旧表有 `targetType`，将它转换到新版 `type`：
  - `image -> IMAGE`
  - `video -> VIDEO`
  - `file -> FILE`
  - `chat_record/chat-record/record -> CHAT_RECORD`
  - 其他默认 `MESSAGE`
- 回填空时间字段。
- 清理没有对应 `chat_users` 记录的孤儿收藏数据，避免重建 `userId` 外键失败。
- 重建新版唯一索引：
  - `userId + type + targetId`
- 重建常用查询索引：
  - `userId + type + collectedAt`
  - `sourceType + sourceId`

新增校验脚本：

```text
prisma/repairs/20260710_verify_chat_favorites_schema.sql
prisma/repairs/20260710_verify_chat_auxiliary_tables.sql
```

## 6. 已执行的修复动作

执行收藏表修复：

```bash
pnpm exec prisma db execute \
  --file prisma/repairs/20260710_fix_chat_favorites_schema.sql \
  --schema prisma/schema.prisma
```

执行后结果：

```text
Script executed successfully.
```

执行收藏表列校验：

```bash
pnpm exec prisma db execute \
  --file prisma/repairs/20260710_verify_chat_favorites_schema.sql \
  --schema prisma/schema.prisma
```

执行后结果：

```text
Script executed successfully.
```

校验辅助表存在后，将已有结构对应的迁移标记为已应用：

```bash
pnpm exec prisma migrate resolve --applied 20260626000000_add_chat_friendships
pnpm exec prisma migrate resolve --applied 20260626000001_add_chat_clear_states
pnpm exec prisma migrate resolve --applied 20260705000000_extend_chat_favorites
```

最终确认：

```bash
pnpm exec prisma migrate status
```

结果：

```text
Database schema is up to date!
```

## 7. 验证结果

已通过：

```bash
pnpm exec prisma validate
pnpm build
pnpm exec prisma migrate status
```

结果：

- Prisma schema 合法。
- Nest 编译通过。
- 当前数据库迁移状态已对齐。
- `chat_favorites.type` 已存在，`GET /api/favorites?...` 不会再因为缺少该列触发 `P2022`。

## 8. 预防措施

后续涉及 Prisma schema 变更时，避免只改 `schema.prisma` 或只执行 `db push`。

推荐流程：

```bash
pnpm prisma:migrate
pnpm prisma:generate
pnpm build
```

上线或远程环境使用：

```bash
pnpm prisma:migrate:deploy
```

注意事项：

- 已应用到数据库的 migration 文件不要再回头修改内容。
- 如果必须修历史库，新增一条后续 migration 或 repair SQL。
- 部署前跑 `pnpm exec prisma migrate status`，确认没有“代码已变、库没变”的漂移。
- Prisma 报 `P2022` 时，优先检查真实数据库列是否和 `schema.prisma` 一致。
