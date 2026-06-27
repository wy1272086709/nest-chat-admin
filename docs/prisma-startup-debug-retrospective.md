# Prisma 启动报错排查复盘（prisma generate / P1001）

> 时间：2026-06-27
> 触发场景：本地启动 NestJS 开发服务器（`pnpm start:dev`）时报错，应用无法启动。

## 背景

执行 `pnpm start:dev` 启动项目时，先后出现了两个不同的错误。本文记录完整排查链路、最终根因，以及避免再次踩坑的注意事项和速查命令。

## 报错现象

整个过程先后出现**两个错误**，它们不是同一回事，需要分别定位：

### 错误一：Prisma Client 未生成

```txt
/Users/mac/.../node_modules/.pnpm/@prisma+client@5.20.0_prisma@5.20.0/
  node_modules/@prisma/client/runtime/library.js:111
You may have to run `prisma generate` for your changes to take effect.
```

### 错误二：连接数据库超时 / 不可达（P1001）

修复错误一后再次启动，编译 0 错误、模块全部初始化、路由全部映射成功，
但在 `PrismaService.onModuleInit` 执行 `$connect()` 时抛出：

```txt
PrismaClientInitializationError: Can't reach database server at `47.122.112.109:5432`.
Please make sure your database server is running at `47.122.112.109:5432`.
errorCode: 'P1001'
```

## 关键背景知识

排查前需要先明确几点，否则容易判断错方向：

1. **Prisma Client 是根据 `schema.prisma` 生成出来的代码**，不在 npm 包里。
   全新安装 / 克隆仓库 / 改完 schema 后，必须手动执行 `prisma generate` 才会产生。
   如果 `node_modules/.prisma/client/`（或 pnpm 虚拟存储里的对应目录）是空的，
   运行时就会抛「You may have to run prisma generate」。

2. **本项目用 pnpm**，生成的客户端不在默认的 `node_modules/.prisma/client/`，
   而是在虚拟存储里：
   ```txt
   node_modules/.pnpm/@prisma+client@5.20.0_prisma@5.20.0/node_modules/@prisma/client
   ```
   这是 pnpm 的正常行为，不是问题，不要去手动改路径。

3. **PrismaClient 在 `onModuleInit` 里同步 `$connect()`**（见 `prisma.service.ts`），
   所以**首次连接数据库失败 = 整个应用启动失败**。这就是为什么 DB 连接超时会让服务起不来。

4. **`prisma generate` 只读 schema，不需要数据库在线**；
   而 `$connect()` 才真正去连数据库，需要网络、账号密码、白名单都正确。

## 排查过程

### 1. 确认是「客户端没生成」

检查生成目录为空：

```bash
ls node_modules/.prisma/client/        # 为空
```

→ 确认是未生成。执行：

```bash
pnpm prisma generate
# ✔ Generated Prisma Client (v5.20.0) to .../node_modules/@prisma/client
```

错误一消除。

### 2. 再次启动 → 撞上 P1001

客户端能正常加载了（编译 0 错误、模块和路由全部初始化），但 `$connect()` 报
「Can't reach database server」。这时第一反应通常是「数据库挂了」或「网络不通」。

### 3. 测 TCP 连通性 → 其实是通的

```bash
nc -z -v -w 5 47.122.112.109 5432
# Connection to 47.122.112.109 port 5432 [tcp/postgresql] succeeded!
```

端口可达、有进程在监听。**P1001 不一定是「网络不通」**，握手阶段失败也可能被报成 P1001。

### 4. 用 psql 测真实连接 → 出现「密码错误」（⚠️ 误报）

```bash
psql "host=47.122.112.109 port=5432 user=admin dbname=app_db sslmode=prefer connect_timeout=5" -c 'select 1;'
# FATAL: password authentication failed for user "admin"
```

这里很容易下错结论：「密码错了」。**实际上这是一个误报**，原因见下一步。

### 5. 用「和应用完全相同的方式」复测 → 连接成功 ✅

关键：之前 psql 测试是用 `sed` 从 `DATABASE_URL` 里抠出密码再传进去，
**没有做 URL 解码**。而 `DATABASE_URL` 里的密码是 URL 编码的：

```txt
admin:910029Abc%23%23@...   # %23%23 就是 "##"
```

- Prisma / 连接库会**自动解码** → 用的是正确密码 `910029Abc##` → 连接成功
- 我的 psql 测试把 `%23%23` 原样当密码 → 认证失败

为了消除这种「工具差异」带来的干扰，写了个一次性脚本，**直接用项目自己的
`@prisma/client` + 项目自己加载的 `.env`** 来连接，和应用运行时一模一样：

```cjs
// 一次性排查脚本（验证完即删）
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const t0 = Date.now();
  try {
    await prisma.$connect();
    const r = await prisma.$queryRaw`SELECT 1 AS ok`;
    console.log('CONNECT_OK', JSON.stringify(r), `(${Date.now() - t0}ms)`);
  } catch (e) {
    console.log('CONNECT_FAIL', e.code || '', '::', (e.message || '').split('\n')[0]);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
})();
```

```bash
set -a && . ./.env && set +a && node ./_dbtest.cjs
# CONNECT_OK [{"ok":1}] (564ms)
```

**结论：数据库可达、账号密码正确，P1001 是启动那一刻的瞬时抖动**（远程库首次握手偏慢，
Prisma 默认 `connect_timeout=5s` 没接住）。再连一次就好了。

### 6. 调大连接超时，避免再次因抖动启动失败

在 `DATABASE_URL` 上加 `connect_timeout`（默认 5 秒）和 `pool_timeout`：

```diff
- DATABASE_URL="postgresql://admin:910029Abc%23%23@47.122.112.109:5432/app_db?schema=public"
+ DATABASE_URL="postgresql://admin:910029Abc%23%23@47.122.112.109:5432/app_db?schema=public&connect_timeout=30&pool_timeout=15"
```

改完后用上面的脚本复测，连接正常（600ms）。最终完整启动通过：

```txt
✅ Prisma connected to database
✅ Email service initialized successfully
[NestApplication] Nest application successfully started +940ms
Application is running on: http://localhost:3000/api
Swagger documentation: http://localhost:3000/docs
```

## 最终根因

1. **错误一**：全新安装后没有执行 `prisma generate`，Prisma Client 代码缺失，运行时直接报错。
2. **错误二**：远程 PostgreSQL（阿里云 `47.122.112.109`）首次连接握手偏慢，
   而 Prisma 默认 `connect_timeout=5s` 偏紧，启动时偶发超时被报成 P1001。
   数据库本身、网络、账号密码都没问题。

## 已做的修复

| 项 | 改动 | 位置 |
|----|------|------|
| 生成客户端 | `pnpm prisma generate`（一次性） | `node_modules/.../@prisma/client` |
| 调大连接超时 | `connect_timeout=30`、`pool_timeout=15` | `.env` 的 `DATABASE_URL` |

> 说明：`prisma generate` 的产物在 `node_modules` 内，不在 git 里，
> 每次全新安装 / 改 schema 后都要重新执行一次。

## 以后遇到「Prisma 启动报错」的排查顺序

1. **看是不是「客户端没生成」**
   - 报错含 `prisma generate` / `@prisma/client/runtime/library.js` → 先跑 `pnpm prisma generate`
   - 改过 `schema.prisma` 后也必须重新 generate

2. **看是不是数据库连不上（P1001 / P1003 等）**
   - 先测 TCP：`nc -z -v -w 5 <host> <port>`
   - TCP 通但还是 P1001 → 多半是握手 / 认证 / 超时问题，往下查

3. **用「应用同款方式」复测，避免工具差异误判**
   - ⚠️ 不要用 `sed` 抠密码丢给 `psql`：`DATABASE_URL` 里的密码是 URL 编码的，
     `psql` 不会自动解码，会误报「密码错误」
   - 推荐直接用项目的 `@prisma/client` 跑一次 `$connect()` + `SELECT 1`（脚本见上文）

4. **区分「瞬时抖动」和「持续故障」**
   - 复测一次成功 → 瞬时抖动 → 调大 `connect_timeout` 即可
   - 复测持续失败 → 看具体错误码：
     - `P1001` 连不上 / 超时：网络、白名单、安全组
     - 认证类：账号密码、URL 编码
     - `P1003`：数据库不存在

5. **看运行环境是否正确**
   - 确认 `.env` 已被加载（`set -a && . ./.env && set +a`）
   - 确认跑在项目根目录（`pnpm -C <项目目录>` 或先 `cd`）

## 常用排查命令速查

```bash
# 1. 生成 / 重新生成 Prisma Client（改完 schema 必跑）
pnpm prisma:generate          # = pnpm prisma generate

# 2. 测数据库 TCP 是否可达
nc -z -v -w 5 47.122.112.109 5432

# 3. 用项目自己的客户端做「真实」连接测试（最权威）
cat > _dbtest.cjs <<'EOF'
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  try { await prisma.$connect(); console.log('CONNECT_OK', JSON.stringify(await prisma.$queryRaw`SELECT 1 AS ok`)); }
  catch (e) { console.log('CONNECT_FAIL', e.code || '', '::', (e.message||'').split('\n')[0]); }
  finally { await prisma.$disconnect().catch(()=>{}); }
})();
EOF
set -a && . ./.env && set +a && node ./_dbtest.cjs && rm -f ./_dbtest.cjs

# 4. 查看 Prisma 的迁移状态 / 同步结构
pnpm prisma:migrate dev       # 开发环境迁移（会改库结构）
pnpm prisma:studio            # 可视化查看数据

# 5. 启动开发服务器（注意要在项目目录里执行）
pnpm start:dev
```

## 注意事项

- **`.env` 里的密码是 URL 编码的**：`%23` = `#`、`%40` = `@`、`%2F` = `/`。
  自己写脚本连接时要么直接把整个 `DATABASE_URL` 交给库去解析（自动解码），
  要么手动解码，**不要用 `sed` 原样抠出来用**，会误报认证失败。

- **`prisma generate` 产物不进 git**：`node_modules` 重装后、`schema.prisma` 改动后都要重跑。
  团队协作时，拉代码后如果遇到 `prisma generate` 报错，先跑一次再启动。

- **远程数据库首连偏慢是常态**：跨地域 / 云数据库首次握手 500ms~1s 很常见，
  默认 5 秒 `connect_timeout` 偶尔会不够，调到 30 秒更稳。
  如果仍然频繁超时，再排查网络 / 安全组 / 白名单。

- **`PrismaService` 在 `onModuleInit` 同步连接**：因此 DB 连接失败 = 启动失败。
  如果希望「DB 暂时不可用时服务也能起来」（弱依赖场景），需要把连接改成异步重试 / 延迟连接，
  目前本项目是强依赖，保持启动即连即可。

- **后台运行项目命令时注意工作目录**：某些执行环境的后台任务会回到主工作目录而非项目目录，
  这时 `pnpm start:dev` 会报 `Command "start:dev" not found`，需用 `pnpm -C <项目目录> start:dev`。
