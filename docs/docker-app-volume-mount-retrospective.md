# Docker `/app` 挂载导致 NestJS 启动失败复盘

## 1. 问题现象

容器启动后反复退出，日志显示：

```text
Error: Cannot find module '/app/dist/src/main.js'
code: 'MODULE_NOT_FOUND'
```

Dockerfile 的启动命令为：

```dockerfile
CMD ["node", "dist/src/main.js"]
```

当前项目执行 `pnpm build` 后，入口文件确实是：

```text
/app/dist/src/main.js
```

因此，这次问题不是 Node 启动路径写错，而是容器启动时 `/app` 的内容被覆盖了。

## 2. 根因

部署脚本使用了以下挂载：

```bash
-v "$PWD":/app
```

Docker 会先根据镜像创建容器，再应用挂载。挂载完成后，容器原有的 `/app` 会被宿主机当前目录遮蔽。

```text
镜像中的 /app                 容器启动后的 /app
--------------------------    --------------------------
dist/src/main.js              宿主机当前项目目录的内容
node_modules                  宿主机当前项目目录的内容
prisma                        宿主机当前项目目录的内容
package.json                  宿主机当前项目目录的内容
```

如果宿主机项目目录没有执行过 `pnpm build`，就不存在 `dist/src/main.js`，Node 随即报 `MODULE_NOT_FOUND`。即使宿主机存在构建产物，整体挂载仍可能引入以下问题：

- 宿主机的 `node_modules` 缺失，覆盖镜像内已安装的生产依赖。
- macOS 或 Windows 上安装的原生依赖与 Linux 容器不兼容。
- 宿主机旧的 `dist` 与当前镜像版本不一致。
- 宿主机源码的权限可能导致容器中的 `node` 用户无法读取或写入。
- 镜像不再是实际运行内容的唯一来源，回滚和问题定位变得困难。

## 3. 推荐方案：只挂载运行期数据

当前静态文件配置为：

```ts
rootPath: join(__dirname, '..', 'uploads'),
serveRoot: '/uploads',
```

编译后的 `__dirname` 是 `/app/dist/src`，所以静态文件实际目录是：

```text
/app/dist/uploads
```

部署时只挂载 uploads：

```bash
docker run -d \
  --publish 3000:3000 \
  --name "$CONTAINER" \
  --volume "$PWD/uploads:/app/dist/uploads" \
  --restart unless-stopped \
  --network common-network \
  --env-file "$ENV_FILE" \
  "$IMAGE"
```

宿主机需要提前创建目录并保证容器中的 `node` 用户具有写权限：

```bash
mkdir -p uploads
```

文件对应关系：

```text
宿主机：<项目目录>/uploads/index.html
容器内：/app/dist/uploads/index.html
访问地址：http://<服务器>:3000/uploads/index.html
```

更适合生产环境的命名卷写法是：

```bash
docker volume create nest-admin-uploads

docker run -d \
  --publish 3000:3000 \
  --name "$CONTAINER" \
  --volume nest-admin-uploads:/app/dist/uploads \
  --restart unless-stopped \
  --network common-network \
  --env-file "$ENV_FILE" \
  "$IMAGE"
```

命名卷由 Docker 管理，不依赖部署脚本运行时所在的目录。需要直接管理上传文件时，宿主机目录挂载更直观。

## 4. 如果确实要挂载整个宿主机项目

完整项目挂载的语法就是：

```bash
--volume "$PWD:/app"
```

但此时宿主机目录会成为容器的实际应用目录。启动容器前，宿主机至少必须存在：

```text
dist/src/main.js
node_modules/
package.json
prisma/
```

可在 Linux 服务器上先执行：

```bash
pnpm install --prod --frozen-lockfile
pnpm prisma:generate
pnpm build
```

然后再启动容器。这种方式更接近“使用容器提供 Node 运行时”，而不是运行一个自包含的应用镜像，不建议作为本项目的生产部署方式。

### 保留镜像中的构建产物和依赖

开发环境若需要挂载全部源码，同时保留镜像里的 `dist` 和 `node_modules`，可以使用独立卷遮住这两个子目录：

```bash
docker run -d \
  --publish 3000:3000 \
  --name "$CONTAINER" \
  --volume "$PWD:/app" \
  --volume /app/dist \
  --volume /app/node_modules \
  --volume "$PWD/uploads:/app/dist/uploads" \
  --env-file "$ENV_FILE" \
  "$IMAGE"
```

挂载按路径分别生效：

- `/app` 来自宿主机项目目录。
- `/app/dist` 使用基于镜像内容初始化的匿名卷。
- `/app/node_modules` 使用基于镜像内容初始化的匿名卷。
- `/app/dist/uploads` 再单独映射到宿主机 uploads 目录。

匿名卷在删除容器后可能继续残留。需要自动清理时使用 `docker rm -v`，或改成明确命名的卷。这个方案适合临时调试，不适合常规生产发布，因为卷中的 `dist` 可能与后续镜像版本不一致。

## 5. 如果想持久化容器的整个 `/app`

也可以把整个 `/app` 放到 Docker 命名卷：

```bash
docker volume create nest-admin-app

docker run -d \
  --publish 3000:3000 \
  --name "$CONTAINER" \
  --volume nest-admin-app:/app \
  --env-file "$ENV_FILE" \
  "$IMAGE"
```

首次使用空卷时，Docker 会把镜像中 `/app` 的已有内容复制到卷中。但后续重新构建镜像并重建容器时，已有卷不会自动更新，因此新镜像中的代码可能无法生效。应用代码不应通过这种方式持久化。

## 6. 部署检查命令

确认镜像自身包含入口文件：

```bash
docker run --rm --entrypoint sh "$IMAGE" -c 'ls -l /app/dist/src/main.js'
```

确认容器实际挂载：

```bash
docker inspect "$CONTAINER" --format '{{json .Mounts}}'
```

确认运行中容器看到的入口文件：

```bash
docker exec "$CONTAINER" ls -l /app/dist/src/main.js
```

查看启动日志：

```bash
docker logs --tail 200 "$CONTAINER"
```

## 7. 结论

生产部署应让代码、编译产物和依赖来自同一个不可变镜像，只把 uploads、日志或其他运行期数据目录单独挂载出去。本项目当前应删除 `-v "$PWD":/app`，改为：

```bash
--volume "$PWD/uploads:/app/dist/uploads"
```

这样镜像内的 `/app/dist/src/main.js` 和 `/app/node_modules` 不会被覆盖，同时上传文件可以跨容器重建保留。
