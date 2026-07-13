import { Module, Global } from '@nestjs/common';
import { RedisService } from './services/redis.service';
import { EmailService } from './services/email.service';
import { RabbitmqService } from './services/rabbitmq.service';
import { MailQueueService } from './services/mail-queue.service';
import { MailQueueConsumer } from './services/mail-queue.consumer';
import { TransformInterceptor } from './interceptors/transform.interceptor';

/**
 * 核心基础服务模块 - 提供核心基础服务
 * 包含 Redis 缓存、邮件服务、通用拦截器等
 */
@Global()
@Module({
  providers: [
    RedisService,
    EmailService,
    RabbitmqService,
    MailQueueService,
    MailQueueConsumer,
    TransformInterceptor,
  ],
  exports: [
    RedisService,
    EmailService,
    RabbitmqService,
    MailQueueService,
    TransformInterceptor,
  ],
})
export class CoreModule {}
