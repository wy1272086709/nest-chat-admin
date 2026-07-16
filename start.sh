#!/bin/bash
# 1. 停止旧版本应用
docker stop nest-admin-chat 2>/dev/null || true
docker rm nest-admin-chat 2>/dev/null || true

# 2. 重新构建镜像
docker build -t nest-admin-chat:latest .

# 3. 使用同一个新镜像执行数据库迁移
docker run --rm \
  --env-file .env \
  --network host \
  nest-admin-chat:latest \
  pnpm prisma:migrate:deploy

# 4. 启动新版本应用
docker run -d \
  --name nest-admin-chat \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  nest-admin-chat:latest