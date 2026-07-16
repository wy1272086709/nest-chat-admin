# 1. 重新构建镜像
docker build -t nest-admin-chat:latest .

# 2. 使用同一个新镜像执行数据库迁移
docker run --rm \ 
  --network host \
  --env-file .env \
  nest-admin-chat:latest \
  pnpm prisma:migrate:deploy

# 3. 启动新版本应用
docker run -d \
  --name nest-admin-chat \
  --env-file .env \
  -p 3000:3000 \
  nest-admin-chat:latest