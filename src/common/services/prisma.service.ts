import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    console.log('✅ Prisma connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    console.log('🔌 Prisma disconnected');
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
        error: error.message,
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
        console.warn(`Slow query detected: ${duration}ms`, query[0]);
      }
      return result;
    } catch (error) {
      console.error(`Query failed: ${query[0]}`, error);
      throw error;
    }
  }
}