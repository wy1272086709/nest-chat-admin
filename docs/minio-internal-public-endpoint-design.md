# MinIO 内外网地址分离设计

## 1. 问题背景

Docker 部署中，Nest 服务连接 MinIO 通常使用容器 DNS：

```env
MINIO_ENDPOINT=minio
MINIO_PORT=9000
```

这个地址只在 Docker 网络内部有效，浏览器或 Electron 客户端无法解析 `minio`。如果使用同一个 Client 生成预签名 URL，返回地址可能包含：

```text
http://minio:9000/public/...
```

客户端拿到该地址后会上传或预览失败。

## 2. 设计原则

MinIO 的内部连接地址和外部访问地址必须分开配置：

```text
Nest 容器 -> MINIO_ENDPOINT=minio:9000
浏览器    -> MINIO_SERVER_URL=http://公网地址:9000
```

不能生成预签名 URL 后再简单替换域名。域名和 Host 会参与 S3 签名计算，修改 URL 主机可能导致签名校验失败。

## 3. 当前实现

系统创建两个 MinIO Client：

### 3.1 内部 Client

配置名：`MINIO_CLIENT`

用途：

- 服务端内部读写对象；
- 后台任务或消费者访问 MinIO；
- 使用 Docker 网络地址；

配置示例：

```env
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
```

### 3.2 公共 Client

配置名：`MINIO_PUBLIC_CLIENT`

用途：

- 生成上传预签名 URL；
- 生成预览预签名 URL；
- 确保返回地址可以被浏览器访问；

公共 Client 从 `MINIO_SERVER_URL` 解析主机、端口和协议：

```env
MINIO_SERVER_URL=http://47.122.112.109:9000
```

返回给客户端的预签名 URL 使用该公共地址，不会携带 `http://minio:9000`。

## 4. 生产环境配置

使用公网 IP：

```env
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_SERVER_URL=http://47.122.112.109:9000
```

使用域名和 HTTPS：

```env
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_SERVER_URL=https://minio.example.com
```

当通过 HTTPS 反向代理访问 MinIO 时，外部协议由 `MINIO_SERVER_URL` 决定；内部 Client 仍可以通过 Docker 网络使用 HTTP。两者不要求使用相同协议。

## 5. 网络和安全要求

部署前必须确认：

- `MINIO_SERVER_URL` 可以从浏览器所在网络访问；
- 公共 URL 的端口或反向代理路径已开放；
- MinIO CORS 允许前端站点的请求来源、方法和请求头；
- 反向代理正确转发 `Host`、查询参数和 `PUT` 请求体；
- 预签名 URL 的有效期符合业务要求；
- 不要把 `MINIO_ENDPOINT` 改成公网 IP 来解决浏览器访问问题。

直接把 `MINIO_ENDPOINT` 改成公网地址会让 Docker 内部服务依赖公网网络，增加 DNS、防火墙、路由和证书问题，不应作为修复方案。

## 6. 故障排查

### URL 包含 `minio`

检查：

```text
MINIO_SERVER_URL 是否配置
MINIO_PUBLIC_CLIENT 是否用于 presignedPutObject/presignedGetObject
```

### 浏览器提示签名无效

检查：

- 是否手工替换过预签名 URL 域名；
- 反向代理是否修改了 Host 或查询参数；
- 服务器时间是否准确；
- URL 是否已过期。

### 浏览器无法连接

检查：

- `MINIO_SERVER_URL` 的主机和端口是否可达；
- 云服务器安全组和防火墙；
- CORS 配置；
- HTTPS 证书和混合内容限制。

## 7. 代码边界

MinIO Module 负责创建并导出两个 Client。Controller 不拼接 URL、不替换域名，只选择正确的 Client 生成预签名地址。后续新增 MinIO 操作时，应根据调用方选择：服务端内部操作使用 `MINIO_CLIENT`，返回给浏览器的预签名操作使用 `MINIO_PUBLIC_CLIENT`。
