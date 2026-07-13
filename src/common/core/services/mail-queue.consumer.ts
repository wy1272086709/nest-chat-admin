import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, ConsumeMessage } from 'amqplib';
import { EmailService } from './email.service';
import {
  MailQueueService,
  MailVerificationSendMessage,
} from './mail-queue.service';
import { RabbitmqService } from './rabbitmq.service';
import { RedisService } from './redis.service';

@Injectable()
export class MailQueueConsumer implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly mailQueueService: MailQueueService,
    private readonly rabbitmqService: RabbitmqService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    const enabled = this.configService.get<boolean>(
      'rabbitmq.mailConsumerEnabled',
      true,
    );
    if (!enabled) return;

    try {
      await this.mailQueueService.setupTopology();
      await this.rabbitmqService.prefetch(
        this.configService.get<number>('rabbitmq.mailVerificationPrefetch', 5),
      );
      await this.rabbitmqService.consume(
        this.mailQueueService.queue,
        (message, channel) => this.handleMessage(message, channel),
      );
      console.log('[MailQueue] consumer started');
    } catch (error) {
      console.error('[MailQueue] consumer 启动失败，应用将继续运行:', error);
    }
  }

  private async handleMessage(message: ConsumeMessage, channel: Channel) {
    const payload = this.parseMessage(message);
    if (!payload) {
      channel.ack(message);
      return;
    }

    try {
      await this.sendVerificationEmail(payload);
      channel.ack(message);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '邮件发送失败';
      const attempts = this.getAttempts(message) + 1;

      try {
        if (attempts >= this.mailQueueService.maxRetry) {
          await this.mailQueueService.publishDeadLetter(
            payload,
            attempts,
            errorMessage,
          );
          console.error('[MailQueue] 邮件任务进入死信队列:', {
            eventId: payload.eventId,
            email: payload.email,
            attempts,
            errorMessage,
          });
        } else {
          await this.mailQueueService.publishRetry(
            payload,
            attempts,
            errorMessage,
          );
          console.warn('[MailQueue] 邮件任务稍后重试:', {
            eventId: payload.eventId,
            email: payload.email,
            attempts,
            errorMessage,
          });
        }
        channel.ack(message);
      } catch (publishError) {
        console.error('[MailQueue] 发布重试/死信失败:', publishError);
        channel.nack(message, false, true);
      }
    }
  }

  private async sendVerificationEmail(payload: MailVerificationSendMessage) {
    const sentKey = this.getSentKey(payload.eventId);
    const sent = await this.redisService.get(sentKey);
    if (sent) {
      console.log('[MailQueue] 邮件任务已处理，跳过重复消费:', payload.eventId);
      return;
    }

    const storedCode = await this.redisService.get(payload.codeKey);
    if (!storedCode) {
      console.warn('[MailQueue] 验证码已过期或不存在，跳过邮件发送:', {
        eventId: payload.eventId,
        email: payload.email,
      });
      await this.redisService.set(sentKey, 'expired', 10 * 60);
      return;
    }

    if (storedCode !== payload.code) {
      console.warn('[MailQueue] 验证码已被新请求覆盖，跳过旧邮件发送:', {
        eventId: payload.eventId,
        email: payload.email,
      });
      await this.redisService.set(sentKey, 'superseded', 10 * 60);
      return;
    }

    await this.emailService.sendVerificationCode(payload.email, payload.code);
    await this.redisService.set(sentKey, 'sent', 10 * 60);
  }

  private parseMessage(
    message: ConsumeMessage,
  ): MailVerificationSendMessage | null {
    try {
      const payload = JSON.parse(
        message.content.toString(),
      ) as MailVerificationSendMessage;
      if (
        !payload?.eventId ||
        !payload.email ||
        !payload.code ||
        !payload.codeKey
      ) {
        console.error('[MailQueue] 邮件任务消息格式错误:', payload);
        return null;
      }

      return payload;
    } catch (error) {
      console.error('[MailQueue] 邮件任务消息解析失败:', error);
      return null;
    }
  }

  private getAttempts(message: ConsumeMessage): number {
    const attempts = message.properties.headers?.['x-attempts'];
    return typeof attempts === 'number' ? attempts : Number(attempts || 0);
  }

  private getSentKey(eventId: string) {
    return `mail:verification:sent:${eventId}`;
  }
}
