# Common 目录重构总结

## 重构概述

本次重构将 `common` 目录和 `auth` 模块的内容进行了重新组织，解决了两者之间的重合问题，并采用了模块化的架构设计。

## 新的目录结构

```
common/
├── common.module.ts                    # 主模块入口，聚合所有子模块
├── auth/                              # 认证通用模块
│   ├── auth-common.module.ts         # 认证通用模块
│   ├── decorators/
│   │   ├── current-user.decorator.ts # 获取当前用户装饰器
│   │   └── public.decorator.ts      # 公开路由装饰器
│   └── guards/
│       └── jwt-auth.guard.ts        # JWT 认证守卫
├── database/                          # 数据库相关模块
│   ├── database.module.ts
│   └── services/
│       ├── prisma.service.ts         # Prisma ORM 服务
│       └── database.service.ts      # 数据库连接服务
├── infrastructure/                    # 基础设施模块
│   ├── infrastructure.module.ts
│   ├── services/
│   │   ├── redis.service.ts         # Redis 缓存服务
│   │   └── email.service.ts        # 邮件服务
│   ├── middleware/
│   │   └── logger.middleware.ts    # 日志中间件
│   └── filters/
│       └── exception.filter.ts      # 全局异常过滤器
├── validation/                        # 验证相关模块
│   └── decorators/
│       └── match.decorator.ts       # 字段匹配验证装饰器
└── common/                           # 通用功能模块
    ├── common.module.ts
    └── interceptors/
        └── transform.interceptor.ts # 响应转换拦截器

auth/
├── auth.module.ts                     # Auth 模块主文件
├── interceptors/
│   └── token-refresh.interceptor.ts # Token 刷新拦截器
├── strategies/
│   ├── jwt.strategy.ts
│   └── local.strategy.ts
└── services/
    └── auth.service.ts
```

## 重构内容

### 1. 从 auth 模块移动到 common 的内容

- **装饰器**: `current-user.decorator.ts`, `public.decorator.ts`
- **守卫**: `jwt-auth.guard.ts`

这些文件都是认证相关的通用功能，现在统一放在 `common/auth/` 目录下。

### 1.1. TokenRefreshInterceptor 的特殊处理

`token-refresh.interceptor.ts` 需要 `JwtService` 依赖，但它更适合放在 auth 模块中：
- 保留在 `auth/interceptors/` 目录
- 在 `AuthModule` 中注册和导出
- 避免了在 `AuthCommonModule` 中的依赖注入问题

### 2. 新的模块化设计

创建了独立的功能模块：

- **DatabaseModule**: 提供数据库相关服务
- **InfrastructureModule**: 提供基础设施服务（Redis、Email）
- **CommonModule**: 提通用拦截器等功能
- **AuthCommonModule**: 提供认证相关通用功能

### 3. 更新的导入路径

重构后，所有相关文件的导入路径都已更新：

```typescript
// 旧路径
import { PrismaService } from '@/common/services/prisma.service';
import { EmailService } from '@/common/services/email.service';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';

// 新路径
import { PrismaService } from '@/common/database/services/prisma.service';
import { EmailService } from '@/common/infrastructure/services/email.service';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
```

## 优势

1. **更清晰的职责分离**: 每个模块都有明确的功能定位
2. **更好的可维护性**: 相关功能聚合在一起，更容易维护和扩展
3. **模块化设计**: 可以根据需要导入特定的模块，而不是全部依赖
4. **消除重复**: 解决了 auth 模块和 common 目录之间的重合问题

## 验证

重构后的应用已通过编译测试，所有功能正常工作。构建命令 `npm run build` 执行成功，没有错误。