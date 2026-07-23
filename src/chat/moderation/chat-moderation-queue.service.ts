import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CHAT_MODERATION_TOPOLOGY,
  RABBITMQ_EXCHANGES,
} from '@/common/core/constants/rabbitmq-topology.constant';
import { RabbitmqService } from '@/common/core/services/rabbitmq.service';
import { MessageModerationRequestedV1 } from './chat-moderation.types';

@Injectable()
export class ChatModerationQueueService {
  private readonly logger = new Logger(ChatModerationQueueService.name);
  private topologyReady: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly rabbitmq: RabbitmqService,
  ) {}

  get queue() {
    return CHAT_MODERATION_TOPOLOGY.queue;
  }

  get deadLetterQueue() {
    return CHAT_MODERATION_TOPOLOGY.deadLetterQueue;
  }

  get maxRetry() {
    return this.config.get<number>('rabbitmq.chatModerationMaxRetry', 3);
  }

  async setupTopology() {
    if (!this.topologyReady) {
      this.topologyReady = this.createTopology().catch((error) => {
        this.topologyReady = null;
        throw error;
      });
    }
    return this.topologyReady;
  }

  async publishRequested(event: MessageModerationRequestedV1) {
    await this.setupTopology();
    await this.rabbitmq.publish(
      RABBITMQ_EXCHANGES.events,
      CHAT_MODERATION_TOPOLOGY.routingKey,
      event,
      this.publishOptions(event.eventId, 0),
    );
    this.logger.log({
      event: 'chat_moderation.message_published',
      eventId: event.eventId,
      messageId: event.messageId,
      queue: CHAT_MODERATION_TOPOLOGY.queue,
      routingKey: CHAT_MODERATION_TOPOLOGY.routingKey,
    });
  }

  async publishRetry(
    event: MessageModerationRequestedV1,
    attempts: number,
    errorCode: string,
  ) {
    await this.rabbitmq.publish(
      RABBITMQ_EXCHANGES.retry,
      CHAT_MODERATION_TOPOLOGY.retryRoutingKey,
      event,
      this.publishOptions(event.eventId, attempts, errorCode),
    );
  }

  async publishDeadLetter(
    event: MessageModerationRequestedV1,
    attempts: number,
    errorCode: string,
  ) {
    await this.rabbitmq.publish(
      RABBITMQ_EXCHANGES.deadLetter,
      CHAT_MODERATION_TOPOLOGY.deadLetterRoutingKey,
      event,
      this.publishOptions(event.eventId, attempts, errorCode),
    );
    this.logger.error({
      event: 'chat_moderation.dead_letter_published',
      eventId: event.eventId,
      attempts,
      errorCode,
    });
  }

  private async createTopology() {
    await this.rabbitmq.assertTopicExchange(RABBITMQ_EXCHANGES.events);
    await this.rabbitmq.assertTopicExchange(RABBITMQ_EXCHANGES.retry);
    await this.rabbitmq.assertTopicExchange(RABBITMQ_EXCHANGES.deadLetter);

    const channel = await this.rabbitmq.getChannel();
    await channel.assertQueue(CHAT_MODERATION_TOPOLOGY.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': RABBITMQ_EXCHANGES.deadLetter,
        'x-dead-letter-routing-key':
          CHAT_MODERATION_TOPOLOGY.deadLetterRoutingKey,
      },
    });
    await channel.bindQueue(
      CHAT_MODERATION_TOPOLOGY.queue,
      RABBITMQ_EXCHANGES.events,
      CHAT_MODERATION_TOPOLOGY.routingKey,
    );
    await channel.assertQueue(CHAT_MODERATION_TOPOLOGY.retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': this.config.get<number>(
          'rabbitmq.chatModerationRetryDelayMs',
          10000,
        ),
        'x-dead-letter-exchange': RABBITMQ_EXCHANGES.events,
        'x-dead-letter-routing-key': CHAT_MODERATION_TOPOLOGY.routingKey,
      },
    });
    await channel.bindQueue(
      CHAT_MODERATION_TOPOLOGY.retryQueue,
      RABBITMQ_EXCHANGES.retry,
      CHAT_MODERATION_TOPOLOGY.retryRoutingKey,
    );
    await channel.assertQueue(CHAT_MODERATION_TOPOLOGY.deadLetterQueue, {
      durable: true,
    });
    await channel.bindQueue(
      CHAT_MODERATION_TOPOLOGY.deadLetterQueue,
      RABBITMQ_EXCHANGES.deadLetter,
      CHAT_MODERATION_TOPOLOGY.deadLetterRoutingKey,
    );
  }

  private publishOptions(
    eventId: string,
    attempts: number,
    errorCode?: string,
  ) {
    return {
      messageId: eventId,
      persistent: true,
      headers: {
        'x-attempts': attempts,
        ...(errorCode ? { 'x-last-error-code': errorCode } : {}),
      },
    };
  }
}
