#!/bin/bash
# 用法: ./deploy.sh <dev|prod>
# 分环境部署:按参数加载 .env.<env>,启动依赖、构建镜像、迁移、运行应用。
#   dev  -> .env.dev  镜像 nest-admin-chat:dev   容器 nest-admin-chat-dev
#   prod -> .env.prod 镜像 nest-admin-chat:prod  容器 nest-admin-chat-prod
# 依赖(minio/redis/rabbitmq)也会用同一份 .env.<env> 通过 docker compose 启动。
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  dev|prod) ;;
  *)
    echo "用法: ./deploy.sh <dev|prod>"
    exit 1
    ;;
esac

ENV_FILE=".env.$ENV"
IMAGE="nest-admin-chat:$ENV"
CONTAINER="nest-admin-chat-$ENV"

[ -f "$ENV_FILE" ] || {
  echo "缺少 $ENV_FILE,请从 .env.$ENV.example 复制一份并填入真实配置"
  exit 1
}

# 1. 启动依赖服务(minio/redis/rabbitmq,按环境加载同一份 .env.<env>)
#    ENV_FILE 经 shell 传入供 compose 解析 env_file 路径;
#    --env-file 提供其余插值变量(MINIO_HOST_BIND / 各 *_VERSION_TAG 等)。
echo "==> [$ENV] 启动依赖服务 (minio/redis/rabbitmq)"
ENV_FILE="$ENV_FILE" docker compose -f docker/docker-compose.yml --env-file "$ENV_FILE" up -d

# 2. 清理旧应用容器(docker rm -f 合并 stop+rm;容器不存在时静默,|| true 兜底)
echo "==> [$ENV] 停止并移除旧容器 ($CONTAINER)"
docker rm -f "$CONTAINER" 2>/dev/null || true

# 3. 构建镜像(按环境打 tag,dev/prod 镜像可共存)
echo "==> [$ENV] 构建镜像 ($IMAGE)"
docker build -t "$IMAGE" .

# 4. 用新镜像执行数据库迁移(--rm 用完即删临时容器)
echo "==> [$ENV] 执行数据库迁移"
docker run --rm \
  --env-file "$ENV_FILE" \
  --network host \
  "$IMAGE" \
  pnpm prisma:migrate:deploy

# 5. 启动新版本应用
echo "==> [$ENV] 启动应用 ($CONTAINER)"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --env-file "$ENV_FILE" \
  "$IMAGE"
