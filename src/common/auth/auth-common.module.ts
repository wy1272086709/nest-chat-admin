import { Module, Global } from '@nestjs/common';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

/**
 * 认证通用模块 - 提供认证相关的通用功能
 * 包含 JWT 守卫、认证装饰器
 */
@Global()
@Module({
  providers: [
    JwtAuthGuard,
    // 装饰器不需要作为 provider 注册，但为了模块完整性保留在这里
  ],
  exports: [JwtAuthGuard],
})
export class AuthCommonModule {}
