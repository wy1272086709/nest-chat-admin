import { Module, Global } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { CoreModule } from './core/core.module';
import { AuthCommonModule } from './auth/auth-common.module';

/**
 * 全局通用模块 - 聚合所有子模块
 * 使用 @Global() 装饰器后，其他模块不需要显式导入就可以使用这些服务
 *
 * 包含的子模块：
 * - DatabaseModule: 数据库相关服务 (PrismaService, DatabaseService)
 * - CoreModule: 核心基础服务 (RedisService, EmailService, TransformInterceptor)
 * - AuthCommonModule: 认证通用功能 (JwtAuthGuard)
 */
@Global()
@Module({
  imports: [
    DatabaseModule,
    CoreModule,
    AuthCommonModule,
  ],
  exports: [
    DatabaseModule,
    CoreModule,
    AuthCommonModule,
  ],
})
export class CommonModule {}
