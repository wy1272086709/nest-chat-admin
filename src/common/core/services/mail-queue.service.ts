import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RabbitmqService } from './rabbitmq.service';
import {
  MAIL_VERIFICATION_TOPOLOGY,
  RABBITMQ_EXCHANGES,
} from '../constants/rabbitmq-topology.constant';

export type MailVerificationType = 'register' | 'forgetPassword';

export type MailVerificationSendMessage = {
  eventId: string;
  email: string;
  type: MailVerificationType;
  code: string;
  codeKey: string;
  requestedAt: string;
  expiresAt: string;
};

@Injectable()
export class MailQueueService {
  private readonly logger = new Logger(MailQueueService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly rabbitmqService: RabbitmqService,
  ) {}

  get queue() {
    return MAIL_VERIFICATION_TOPOLOGY.queue;
  }

  get retryQueue() {
    return MAIL_VERIFICATION_TOPOLOGY.retryQueue;
  }

  get deadLetterQueue() {
    return MAIL_VERIFICATION_TOPOLOGY.deadLetterQueue;
  }

  get routingKey() {
    return MAIL_VERIFICATION_TOPOLOGY.routingKey;
  }

  get retryRoutingKey() {
    return MAIL_VERIFICATION_TOPOLOGY.retryRoutingKey;
  }

  get deadLetterRoutingKey() {
    return MAIL_VERIFICATION_TOPOLOGY.deadLetterRoutingKey;
  }

  get retryDelayMs() {
    return this.configService.get<number>(
      'rabbitmq.mailVerificationRetryDelayMs',
      10000,
    );
  }

  get maxRetry() {
    return this.configService.get<number>(
      'rabbitmq.mailVerificationMaxRetry',
      3,
    );
  }

  async setupTopology(): Promise<void> {
    await this.rabbitmqService.assertTopicExchange(
      RABBITMQ_EXCHANGES.events,
    );
    await this.rabbitmqService.assertTopicExchange(
      RABBITMQ_EXCHANGES.retry,
    );
    await this.rabbitmqService.assertTopicExchange(
      RABBITMQ_EXCHANGES.deadLetter,
    );

    await this.rabbitmqService.assertQueue(this.queue, { durable: true });
    await this.rabbitmqService.bindQueue(
      this.queue,
      RABBITMQ_EXCHANGES.events,
      this.routingKey,
    );

    await this.rabbitmqService.assertQueue(this.retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': this.retryDelayMs,
        'x-dead-letter-exchange': RABBITMQ_EXCHANGES.events,
        'x-dead-letter-routing-key': this.routingKey,
      },
    });
    await this.rabbitmqService.bindQueue(
      this.retryQueue,
      RABBITMQ_EXCHANGES.retry,
      this.retryRoutingKey,
    );

    await this.rabbitmqService.assertQueue(this.deadLetterQueue, {
      durable: true,
    });
    await this.rabbitmqService.bindQueue(
      this.deadLetterQueue,
      RABBITMQ_EXCHANGES.deadLetter,
      this.deadLetterRoutingKey,
    );
  }

  async publishVerificationCode(params: {
    email: string;
    type: MailVerificationType;
    code: string;
    codeKey: string;
    ttlSeconds: number;
  }): Promise<MailVerificationSendMessage> {
    await this.setupTopology();

    const now = new Date();
    const message: MailVerificationSendMessage = {
      eventId: randomUUID(),
      email: params.email,
      type: params.type,
      code: params.code,
      codeKey: params.codeKey,
      requestedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + params.ttlSeconds * 1000,
      ).toISOString(),
    };

    await this.rabbitmqService.publish(
      RABBITMQ_EXCHANGES.events,
      this.routingKey,
      message,
      {
        messageId: message.eventId,
        persistent: true,
        headers: {
          'x-attempts': 0,
        },
      },
    );

    this.logger.log({
      event: 'rabbitmq.message_published',
      eventId: message.eventId,
      queue: this.queue,
      attempts: 0,
    });

    return message;
  }

  async publishRetry(
    message: MailVerificationSendMessage,
    attempts: number,
    errorMessage: string,
  ): Promise<void> {
    await this.rabbitmqService.publish(
      RABBITMQ_EXCHANGES.retry,
      this.retryRoutingKey,
      message,
      {
        messageId: message.eventId,
        persistent: true,
        headers: {
          'x-attempts': attempts,
          'x-last-error': errorMessage,
        },
      },
    );

    this.logger.log({
      event: 'rabbitmq.retry_published',
      eventId: message.eventId,
      queue: this.retryQueue,
      attempts,
    });
  }

  async publishDeadLetter(
    message: MailVerificationSendMessage,
    attempts: number,
    errorMessage: string,
  ): Promise<void> {
    await this.rabbitmqService.publish(
      RABBITMQ_EXCHANGES.deadLetter,
      this.deadLetterRoutingKey,
      {
        ...message,
        failedAt: new Date().toISOString(),
        attempts,
        errorMessage,
      },
      {
        messageId: message.eventId,
        persistent: true,
        headers: {
          'x-attempts': attempts,
          'x-last-error': errorMessage,
        },
      },
    );

    this.logger.log({
      event: 'rabbitmq.dead_letter_published',
      eventId: message.eventId,
      queue: this.deadLetterQueue,
      attempts,
    });
  }
}
