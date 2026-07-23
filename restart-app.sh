#!/bin/bash
# 用法: ./restart-app.sh <dev|prod>
# 仅在应用代码变更时重新构建并替换应用容器，不重启依赖服务或执行数据库迁移。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

ENV="${1:-}"
case "$ENV" in
  dev|prod) ;;
  *)
    echo "用法: ./restart-app.sh <dev|prod>"
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

docker network inspect common-network >/dev/null 2>&1 || {
  echo "缺少 Docker 网络 common-network,请先执行 ./deploy.sh $ENV 启动依赖服务"
  exit 1
}

# 先完成构建，避免构建失败时中断正在运行的应用。
echo "==> [$ENV] 构建应用镜像 ($IMAGE)"
docker build -t "$IMAGE" .

echo "==> [$ENV] 停止并移除旧应用容器 ($CONTAINER)"
docker rm -f "$CONTAINER" 2>/dev/null || true

echo "==> [$ENV] 启动应用 ($CONTAINER)"
docker run -d \
  --publish 3000:3000 \
  --name "$CONTAINER" \
  --volume "$PROJECT_DIR/uploads:/app/dist/uploads" \
  --restart unless-stopped \
  --network common-network \
  --env-file "$ENV_FILE" \
  "$IMAGE"
