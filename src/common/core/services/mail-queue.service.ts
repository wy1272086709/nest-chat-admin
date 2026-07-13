import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RabbitmqService } from './rabbitmq.service';

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
  constructor(
    private readonly configService: ConfigService,
    private readonly rabbitmqService: RabbitmqService,
  ) {}

  get queue() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationQueue',
      'mail.verification.send.queue',
    );
  }

  get retryQueue() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationRetryQueue',
      'mail.verification.send.retry.queue',
    );
  }

  get deadLetterQueue() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationDeadLetterQueue',
      'mail.verification.send.dlq',
    );
  }

  get routingKey() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationRoutingKey',
      'mail.verification.send',
    );
  }

  get retryRoutingKey() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationRetryRoutingKey',
      'mail.verification.send.retry',
    );
  }

  get deadLetterRoutingKey() {
    return this.configService.get<string>(
      'rabbitmq.mailVerificationDeadLetterRoutingKey',
      'mail.verification.send.dlq',
    );
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
      this.rabbitmqService.exchange,
    );
    await this.rabbitmqService.assertTopicExchange(
      this.rabbitmqService.retryExchange,
    );
    await this.rabbitmqService.assertTopicExchange(
      this.rabbitmqService.deadLetterExchange,
    );

    await this.rabbitmqService.assertQueue(this.queue, { durable: true });
    await this.rabbitmqService.bindQueue(
      this.queue,
      this.rabbitmqService.exchange,
      this.routingKey,
    );

    await this.rabbitmqService.assertQueue(this.retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': this.retryDelayMs,
        'x-dead-letter-exchange': this.rabbitmqService.exchange,
        'x-dead-letter-routing-key': this.routingKey,
      },
    });
    await this.rabbitmqService.bindQueue(
      this.retryQueue,
      this.rabbitmqService.retryExchange,
      this.retryRoutingKey,
    );

    await this.rabbitmqService.assertQueue(this.deadLetterQueue, {
      durable: true,
    });
    await this.rabbitmqService.bindQueue(
      this.deadLetterQueue,
      this.rabbitmqService.deadLetterExchange,
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
      this.rabbitmqService.exchange,
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

    return message;
  }

  async publishRetry(
    message: MailVerificationSendMessage,
    attempts: number,
    errorMessage: string,
  ): Promise<void> {
    await this.rabbitmqService.publish(
      this.rabbitmqService.retryExchange,
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
  }

  async publishDeadLetter(
    message: MailVerificationSendMessage,
    attempts: number,
    errorMessage: string,
  ): Promise<void> {
    await this.rabbitmqService.publish(
      this.rabbitmqService.deadLetterExchange,
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
  }
}
