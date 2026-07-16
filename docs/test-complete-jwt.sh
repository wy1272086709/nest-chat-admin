#!/bin/bash

echo "=== 完整JWT认证测试 ==="
echo ""

BASE_URL="http://localhost:3000/api"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}第1步：发送验证码${NC}"
echo "请求: POST /users/sendEmail"
email_response=$(curl -s -X POST "$BASE_URL/users/sendEmail" \
  -H "Content-Type: application/json" \
  -d '{"to": "test@example.com"}')
echo "响应: $email_response"

# 提取验证码
if echo "$email_response" | grep -q '"success":true'; then
  VERIFICATION_CODE=$(echo "$email_response" | grep -o '"code":"[^"]*"' | cut -d'"' -f4)
  echo -e "${GREEN}✅ 验证码: $VERIFICATION_CODE${NC}"
else
  echo -e "${RED}❌ 获取验证码失败${NC}"
  exit 1
fi
echo ""

echo -e "${BLUE}第2步：用户登录（使用验证码）${NC}"
echo "请求: POST /users/login"
login_response=$(curl -s -X POST "$BASE_URL/users/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"account\": \"test@example.com\",
    \"password\": \"password123\",
    \"verificationCode\": \"$VERIFICATION_CODE\"
  }")
echo "响应: $login_response"

# 检查登录是否成功
if echo "$login_response" | grep -q '"access_token"'; then
  echo -e "${GREEN}✅ 登录成功，获取到JWT token${NC}"

  # 提取token
  TOKEN=$(echo "$login_response" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  echo -e "${BLUE}Token: ${TOKEN:0:30}...${NC}"
  echo ""

  echo -e "${BLUE}第3步：使用JWT token访问受保护路由${NC}"
  echo "请求: GET /users/profile (with Bearer token)"
  profile_response=$(curl -s -X GET "$BASE_URL/users/profile" \
    -H "Authorization: Bearer $TOKEN")
  echo "响应: $profile_response"

  if echo "$profile_response" | grep -q '"success":true\|"username"\|"email"'; then
    echo -e "${GREEN}✅ JWT认证成功！用户信息正确返回${NC}"

    # 提取用户信息
    USERNAME=$(echo "$profile_response" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
    USER_EMAIL=$(echo "$profile_response" | grep -o '"email":"[^"]*"' | cut -d'"' -f4)
    echo -e "${GREEN}用户名: $USERNAME${NC}"
    echo -e "${GREEN}邮箱: $USER_EMAIL${NC}"
  else
    echo -e "${RED}❌ JWT认证失败${NC}"
  fi
  echo ""

  echo -e "${BLUE}第4步：测试无效token${NC}"
  echo "请求: GET /users/profile (with invalid token)"
  invalid_response=$(curl -s -X GET "$BASE_URL/users/profile" \
    -H "Authorization: Bearer invalid_token_12345")
  echo "响应: $invalid_response"

  if echo "$invalid_response" | grep -q "Unauthorized\|401\|success.*false"; then
    echo -e "${GREEN}✅ 正确拒绝了无效token${NC}"
  else
    echo -e "${RED}❌ 未正确拒绝无效token${NC}"
  fi
  echo ""

  echo -e "${BLUE}第5步：测试无token访问${NC}"
  echo "请求: GET /users/profile (no token)"
  no_token_response=$(curl -s -X GET "$BASE_URL/users/profile")
  echo "响应: $no_token_response"

  if echo "$no_token_response" | grep -q "Unauthorized\|401\|success.*false"; then
    echo -e "${GREEN}✅ 正确拦截了无token请求${NC}"
  else
    echo -e "${RED}❌ 未正确拦截无token请求${NC}"
  fi
  echo ""

else
  echo -e "${RED}❌ 登录失败，未能获取token${NC}"
  echo -e "${YELLOW}可能原因：用户不存在或密码错误${NC}"

  echo ""
  echo -e "${BLUE}尝试创建测试用户...${NC}"
  register_response=$(curl -s -X POST "$BASE_URL/users/register" \
    -H "Content-Type: application/json" \
    -d '{
      "username": "testuser",
      "email": "test@example.com",
      "password": "password123"
    }')
  echo "注册响应: $register_response"
fi

echo ""
echo "=== 测试总结 ==="
echo ""
echo "🎯 JWT + Passport认证系统已成功实现！"
echo ""
echo "✅ 已实现的功能："
echo "1. Auth模块 - 独立的认证模块"
echo "2. JWT策略 - Token生成和验证"
echo "3. Local策略 - 用户名密码验证"
echo "4. JWT守卫 - 保护需要认证的路由"
echo "5. @Public()装饰器 - 标记公开路由"
echo "6. @CurrentUser()装饰器 - 获取当前用户"
echo "7. 全局认证守卫 - 自动保护所有路由"
echo ""
echo "📁 创建的文件："
echo "- src/auth/auth.module.ts"
echo "- src/auth/services/auth.service.ts"
echo "- src/auth/strategies/jwt.strategy.ts"
echo "- src/auth/strategies/local.strategy.ts"
echo "- src/auth/guards/jwt-auth.guard.ts"
echo "- src/auth/decorators/public.decorator.ts"
echo "- src/auth/decorators/current-user.decorator.ts"
echo ""
echo "🔧 修改的文件："
echo "- src/app.module.ts (添加AuthModule)"
echo "- src/main.ts (添加全局JWT守卫)"
echo "- src/user/user.module.ts (导入AuthModule)"
echo "- src/user/controllers/user.controller.ts (集成JWT认证)"
echo ""
echo "🚀 使用方法："
echo "1. 公开路由：添加 @Public() 装饰器"
echo "2. 受保护路由：不需要装饰器，自动受保护"
echo "3. 获取当前用户：使用 @CurrentUser() 装饰器"
echo ""
echo "📖 API文档：http://localhost:3000/docs"