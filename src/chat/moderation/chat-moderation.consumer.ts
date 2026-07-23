import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageModerationStatus, MessageType, Prisma } from '@prisma/client';
import type { Channel, ConsumeMessage } from 'amqplib';
import { PrismaService } from '@/common/database/services/prisma.service';
import { RabbitmqService } from '@/common/core/services/rabbitmq.service';
import {
  ChatModerationService,
  ModerationResult,
} from './chat-moderation.service';
import { ChatModerationQueueService } from './chat-moderation-queue.service';
import { ChatModerationActionService } from './chat-moderation-action.service';
import {
  CHAT_MODERATION_EVENT_TYPE,
  CHAT_MODERATION_EVENT_VERSION,
  ChatModerationMode,
  MessageModerationRequestedV1,
} from './chat-moderation.types';

@Injectable()
export class ChatModerationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatModerationConsumer.name);
  private startTimer?: NodeJS.Timeout;
  private starting = false;
  private started = false;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitmqService,
    private readonly queue: ChatModerationQueueService,
    private readonly moderation: ChatModerationService,
    private readonly actions: ChatModerationActionService,
  ) {}

  async onModuleInit() {
    if (!this.shouldRun()) return;
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
      await this.queue.setupTopology();
      await this.rabbitmq.consume(
        this.queue.queue,
        (message, channel) => this.handleMessage(message, channel),
        {
          prefetch: this.config.get<number>(
            'rabbitmq.chatModerationPrefetch',
            5,
          ),
        },
      );
      this.logger.log({
        event: 'chat_moderation.consumer_started',
        queue: this.queue.queue,
      });
      this.started = true;
    } catch (error) {
      this.logger.error({
        event: 'chat_moderation.consumer_start_failed',
        errorCode: this.errorCode(error),
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
    const event = this.parseEvent(message);
    if (!event) {
      channel.nack(message, false, false);
      return;
    }
    const attempts = this.getAttempts(message);

    try {
      const processed = await this.prisma.messageModeration.findUnique({
        where: { eventId: event.eventId },
        select: {
          decision: true,
          categories: true,
          confidence: true,
          reason: true,
          model: true,
          statusCode: true,
          durationMs: true,
        },
      });
      if (processed) {
        const result: ModerationResult = {
          decision: processed.decision as ModerationResult['decision'],
          categories: this.toCategories(processed.categories),
          confidence: processed.confidence ?? undefined,
          reason: processed.reason ?? undefined,
          model: processed.model ?? undefined,
          statusCode: processed.statusCode,
          durationMs: processed.durationMs,
        };
        await this.actions.apply(event, result);
        channel.ack(message);
        this.logProcessed(event, result, attempts);
        return;
      }

      const chatMessage = await this.prisma.message.findUnique({
        where: { id: event.messageId },
        select: {
          id: true,
          roomId: true,
          senderId: true,
          content: true,
          messageType: true,
        },
      });
      if (!chatMessage) {
        channel.ack(message);
        return;
      }
      if (
        chatMessage.roomId !== event.roomId ||
        chatMessage.senderId !== event.userId
      ) {
        await this.deadLetter(event, attempts + 1, 'EVENT_MESSAGE_MISMATCH');
        channel.ack(message);
        return;
      }

      if (
        chatMessage.messageType !== MessageType.TEXT ||
        !chatMessage.content?.trim()
      ) {
        const result: ModerationResult = {
          decision: 'PASS',
          categories: [],
          reason: '非文本消息无需审核',
          statusCode: 200,
          durationMs: 0,
        };
        await this.saveResult(event, result);
        channel.ack(message);
        this.logProcessed(event, result, attempts);
        return;
      }

      const result = await this.moderation.moderate({
        content: chatMessage.content,
        userId: event.userId,
        roomId: event.roomId,
      });
      if (result.decision === 'DEGRADED' && result.retryable) {
        throw new RetryableModerationError(
          result.errorCode ?? 'MODERATION_TEMPORARY_ERROR',
        );
      }

      await this.saveResult(event, result);
      await this.actions.apply(event, result);
      channel.ack(message);
      this.logProcessed(event, result, attempts);
    } catch (error) {
      const nextAttempts = attempts + 1;
      const errorCode = this.errorCode(error);
      try {
        if (nextAttempts >= this.queue.maxRetry) {
          await this.deadLetter(event, nextAttempts, errorCode);
          const result: ModerationResult = {
            decision: 'DEGRADED',
            categories: [],
            reason: 'AI 审核重试次数已耗尽',
            statusCode: 503,
            durationMs: 0,
            retryable: false,
            errorCode,
          };
          await this.saveResult(event, result);
          this.logProcessed(event, result, nextAttempts);
        } else {
          await this.queue.publishRetry(event, nextAttempts, errorCode);
        }
        channel.ack(message);
      } catch (publishError) {
        this.logger.error({
          event: 'chat_moderation.retry_publish_failed',
          eventId: event.eventId,
          attempts: nextAttempts,
          errorCode: this.errorCode(publishError),
        });
        channel.nack(message, false, true);
      }
    }
  }

  private async saveResult(
    event: MessageModerationRequestedV1,
    result: ModerationResult,
  ) {
    const status = this.toMessageStatus(result.decision);
    try {
      await this.prisma.$transaction([
        this.prisma.messageModeration.create({
          data: {
            eventId: event.eventId,
            userId: event.userId,
            roomId: event.roomId,
            messageId: event.messageId,
            decision: result.decision,
            categories: result.categories,
            confidence: result.confidence,
            reason: result.reason,
            reviewStatus:
              result.decision === 'PASS' ? 'NOT_REQUIRED' : 'PENDING',
            model: result.model,
            statusCode: result.statusCode,
            durationMs: result.durationMs,
            policyVersion: event.policyVersion,
          },
        }),
        this.prisma.message.update({
          where: { id: event.messageId },
          data: { moderationStatus: status, moderatedAt: new Date() },
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  private async deadLetter(
    event: MessageModerationRequestedV1,
    attempts: number,
    errorCode: string,
  ) {
    await this.queue.publishDeadLetter(event, attempts, errorCode);
  }

  private parseEvent(message: ConsumeMessage) {
    try {
      const event = JSON.parse(
        message.content.toString(),
      ) as MessageModerationRequestedV1;
      if (
        event.eventType !== CHAT_MODERATION_EVENT_TYPE ||
        event.version !== CHAT_MODERATION_EVENT_VERSION ||
        !event.eventId ||
        !event.messageId ||
        !event.userId ||
        !event.roomId ||
        !event.policyVersion
      ) {
        throw new Error('INVALID_EVENT');
      }
      return event;
    } catch (error) {
      this.logger.error({
        event: 'chat_moderation.invalid_event',
        messageId: message.properties.messageId,
        errorCode: this.errorCode(error),
      });
      return null;
    }
  }

  private toMessageStatus(decision: ModerationResult['decision']) {
    const statuses: Record<
      ModerationResult['decision'],
      MessageModerationStatus
    > = {
      PASS: MessageModerationStatus.PASSED,
      REVIEW: MessageModerationStatus.REVIEW,
      REJECT: MessageModerationStatus.REJECTED,
      DEGRADED: MessageModerationStatus.DEGRADED,
    };
    return statuses[decision];
  }

  private toCategories(value: Prisma.JsonValue) {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }

  private getAttempts(message: ConsumeMessage) {
    const attempts = message.properties.headers?.['x-attempts'];
    return typeof attempts === 'number' ? attempts : Number(attempts || 0);
  }

  private logProcessed(
    event: MessageModerationRequestedV1,
    result: ModerationResult,
    attempts: number,
  ) {
    this.logger.log({
      event: 'chat_moderation.message_processed',
      eventId: event.eventId,
      messageId: event.messageId,
      decision: result.decision,
      reason: result.reason ?? null,
      statusCode: result.statusCode,
      errorCode: result.errorCode ?? null,
      durationMs: result.durationMs,
      model: result.model ?? null,
      attempts,
    });
  }

  private shouldRun() {
    const enabled = this.config.get<boolean>(
      'rabbitmq.chatModerationConsumerEnabled',
      true,
    );
    const mode = this.config.get<ChatModerationMode>(
      'ai.moderationMode',
      'async',
    );
    return enabled && (mode === 'async' || mode === 'shadow');
  }

  private errorCode(error: unknown) {
    if (error instanceof RetryableModerationError) return error.code;
    if (error instanceof Error) return error.name || 'ERROR';
    return 'UNKNOWN_ERROR';
  }
}

class RetryableModerationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RetryableModerationError';
  }
}
