import { Module, Global } from '@nestjs/common';
import { PrismaService } from './services/prisma.service';
import { DatabaseService } from './services/database.service';

/**
 * 数据库模块 - 提供数据库相关的服务
 * 包含 Prisma ORM 和数据库连接服务
 */
@Global()
@Module({
  providers: [PrismaService, DatabaseService],
  exports: [PrismaService, DatabaseService],
})
export class DatabaseModule {}
