import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log({ event: 'database.connected' });
  }

  // 健康检查
  async healthCheck() {
    try {
      await this.$queryRaw`SELECT 1`;
      return { status: 'healthy', timestamp: new Date() };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date(),
        error: 'Database health check failed'
      };
    }
  }
}
