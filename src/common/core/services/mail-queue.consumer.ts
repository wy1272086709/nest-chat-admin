import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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
export class MailQueueConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailQueueConsumer.name);
  private startTimer?: NodeJS.Timeout;
  private starting = false;
  private started = false;
  private stopped = false;

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

    await this.start();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.startTimer) clearTimeout(this.startTimer);
  }

  private async start() {
    if (this.started || this.starting || this.stopped) return;
    this.starting = true;
    try {
      await this.mailQueueService.setupTopology();
      await this.rabbitmqService.consume(
        this.mailQueueService.queue,
        (message, channel) => this.handleMessage(message, channel),
        {
          prefetch: this.configService.get<number>(
            'rabbitmq.mailVerificationPrefetch',
            5,
          ),
        },
      );
      this.logger.log({
        event: 'rabbitmq.consumer_started',
        queue: this.mailQueueService.queue,
      });
      this.started = true;
    } catch (error) {
      this.logger.error({
        event: 'rabbitmq.consumer_start_failed',
        queue: this.mailQueueService.queue,
        err: error,
      });
      this.scheduleStartRetry();
    } finally {
      this.starting = false;
    }
  }

  private scheduleStartRetry() {
    if (this.stopped || this.started || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.start();
    }, 5000);
    this.startTimer.unref();
  }

  private async handleMessage(message: ConsumeMessage, channel: Channel) {
    const attempts = this.getAttempts(message);
    const payload = this.parseMessage(message);
    if (!payload) {
      channel.ack(message);
      return;
    }

    try {
      await this.sendVerificationEmail(payload, attempts);
      channel.ack(message);
      this.logger.log({
        event: 'rabbitmq.message_processed',
        eventId: payload.eventId,
        queue: this.mailQueueService.queue,
        attempts,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : '邮件发送失败';
      const nextAttempts = attempts + 1;

      try {
        if (nextAttempts >= this.mailQueueService.maxRetry) {
          await this.mailQueueService.publishDeadLetter(
            payload,
            nextAttempts,
            errorMessage,
          );
          this.logger.error({
            event: 'rabbitmq.message_dead_lettered',
            eventId: payload.eventId,
            queue: this.mailQueueService.deadLetterQueue,
            attempts: nextAttempts,
            errorMessage,
          });
        } else {
          await this.mailQueueService.publishRetry(
            payload,
            nextAttempts,
            errorMessage,
          );
          this.logger.warn({
            event: 'rabbitmq.message_retry_scheduled',
            eventId: payload.eventId,
            queue: this.mailQueueService.retryQueue,
            attempts: nextAttempts,
            errorMessage,
          });
        }
        channel.ack(message);
      } catch (publishError) {
        this.logger.error({
          event: 'rabbitmq.retry_publish_failed',
          eventId: payload.eventId,
          queue: this.mailQueueService.queue,
          attempts: nextAttempts,
          err: publishError,
        });
        channel.nack(message, false, true);
      }
    }
  }

  private async sendVerificationEmail(
    payload: MailVerificationSendMessage,
    attempts: number,
  ) {
    const sentKey = this.getSentKey(payload.eventId);
    const sent = await this.redisService.get(sentKey);
    if (sent) {
      this.logger.log({
        event: 'rabbitmq.duplicate_skipped',
        eventId: payload.eventId,
        queue: this.mailQueueService.queue,
        attempts,
      });
      return;
    }

    const storedCode = await this.redisService.get(payload.codeKey);
    if (!storedCode) {
      this.logger.warn({
        event: 'rabbitmq.expired_message_skipped',
        eventId: payload.eventId,
        queue: this.mailQueueService.queue,
        attempts,
      });
      await this.redisService.set(sentKey, 'expired', 10 * 60);
      return;
    }

    if (storedCode !== payload.code) {
      this.logger.warn({
        event: 'rabbitmq.superseded_message_skipped',
        eventId: payload.eventId,
        queue: this.mailQueueService.queue,
        attempts,
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
        this.logger.error({
          event: 'rabbitmq.invalid_message',
          eventId: message.properties.messageId,
          queue: this.mailQueueService.queue,
          attempts: this.getAttempts(message),
        });
        return null;
      }

      return payload;
    } catch (error) {
      this.logger.error({
        event: 'rabbitmq.message_parse_failed',
        eventId: message.properties.messageId,
        queue: this.mailQueueService.queue,
        attempts: this.getAttempts(message),
        err: error,
      });
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
