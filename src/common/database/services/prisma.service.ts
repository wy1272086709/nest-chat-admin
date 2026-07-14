import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log({ event: 'prisma.connected' });
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log({ event: 'prisma.disconnected' });
  }

  // 健康检查
  async checkHealth() {
    try {
      await this.$queryRaw`SELECT 1`;
      return {
        status: 'healthy',
        timestamp: new Date(),
        database: 'PostgreSQL',
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date(),
        error: 'Database health check failed',
      };
    }
  }

  // 获取查询性能信息
  async queryRaw<T = any>(query: TemplateStringsArray, ...args: any[]): Promise<T> {
    const start = Date.now();
    try {
      const result = await this.$queryRaw.apply(this, [query, ...args]);
      const duration = Date.now() - start;
      if (duration > 1000) {
        this.logger.warn({
          event: 'prisma.slow_query',
          durationMs: duration,
          query: query[0],
        });
      }
      return result;
    } catch (error) {
      this.logger.error({
        event: 'prisma.query_failed',
        query: query[0],
        err: error,
      });
      throw error;
    }
  }
}
