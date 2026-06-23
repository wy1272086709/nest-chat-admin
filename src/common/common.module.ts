import { Module, Global } from '@nestjs/common';
import { PrismaService } from './services/prisma.service';
import { RedisService } from './services/redis.service';
import { EmailService } from './services/email.service';

/**
 * 全局模块 - 提供所有公共服务
 * 使用 @Global() 装饰器后，其他模块不需要显式导入就可以使用这些服务
 */
@Global()
@Module({
  providers: [PrismaService, RedisService, EmailService],
  exports: [PrismaService, RedisService, EmailService],
})
export class CommonModule {}
