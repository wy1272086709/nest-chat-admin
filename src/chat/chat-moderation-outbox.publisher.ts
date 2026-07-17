import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { ModerationOutbox, ModerationOutboxStatus } from '@prisma/client';
import { PrismaService } from '@/common/database/services/prisma.service';
import { ChatModerationQueueService } from './chat-moderation-queue.service';
import {
  ChatModerationMode,
  MessageModerationRequestedV1,
} from './chat-moderation.types';

@Injectable()
export class ChatModerationOutboxPublisher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ChatModerationOutboxPublisher.name);
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastCleanupAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queue: ChatModerationQueueService,
  ) {}

  async onModuleInit() {
    if (!this.shouldRun()) return;
    try {
      await this.queue.setupTopology();
    } catch (error) {
      this.logger.error({
        event: 'chat_moderation.outbox_topology_unavailable',
        error: this.errorCode(error),
      });
    }
    const pollMs = this.config.get<number>(
      'rabbitmq.moderationOutboxPollMs',
      1000,
    );
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const records = await this.claimBatch();
      for (const record of records) await this.publish(record);
      await this.cleanupPublished();
    } catch (error) {
      this.logger.error({
        event: 'chat_moderation.outbox_tick_failed',
        error: this.errorCode(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async claimBatch() {
    const now = new Date();
    const lockMs = this.config.get<number>(
      'rabbitmq.moderationOutboxLockMs',
      30000,
    );
    const staleAt = new Date(now.getTime() - lockMs);
    const candidates = await this.prisma.moderationOutbox.findMany({
      where: this.claimableWhere(now, staleAt),
      orderBy: { createdAt: 'asc' },
      take: this.config.get<number>('rabbitmq.moderationOutboxBatchSize', 50),
    });
    const claimed: ModerationOutbox[] = [];
    for (const candidate of candidates) {
      const result = await this.prisma.moderationOutbox.updateMany({
        where: {
          id: candidate.id,
          ...this.claimableWhere(now, staleAt),
        },
        data: {
          status: ModerationOutboxStatus.PUBLISHING,
          lockedAt: now,
          lockedBy: this.instanceId,
        },
      });
      if (result.count === 1) {
        claimed.push({
          ...candidate,
          status: ModerationOutboxStatus.PUBLISHING,
          lockedAt: now,
          lockedBy: this.instanceId,
        });
      }
    }
    return claimed;
  }

  private async publish(record: ModerationOutbox) {
    try {
      const event = record.payload as unknown as MessageModerationRequestedV1;
      await this.queue.publishRequested(event);
      await this.prisma.moderationOutbox.updateMany({
        where: {
          id: record.id,
          status: ModerationOutboxStatus.PUBLISHING,
          lockedBy: this.instanceId,
        },
        data: {
          status: ModerationOutboxStatus.PUBLISHED,
          publishedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: null,
        },
      });
    } catch (error) {
      const attempts = record.attempts + 1;
      const maxAttempts = this.config.get<number>(
        'rabbitmq.moderationOutboxMaxAttempts',
        10,
      );
      const exhausted = attempts >= maxAttempts;
      await this.prisma.$transaction([
        this.prisma.moderationOutbox.updateMany({
          where: {
            id: record.id,
            status: ModerationOutboxStatus.PUBLISHING,
            lockedBy: this.instanceId,
          },
          data: {
            status: exhausted
              ? ModerationOutboxStatus.FAILED
              : ModerationOutboxStatus.RETRY,
            attempts,
            nextAttemptAt: new Date(Date.now() + this.retryDelay(attempts)),
            lockedAt: null,
            lockedBy: null,
            lastErrorCode: this.errorCode(error),
          },
        }),
        ...(exhausted
          ? [
              this.prisma.message.updateMany({
                where: { id: record.aggregateId, moderationStatus: 'PENDING' },
                data: { moderationStatus: 'DEGRADED', moderatedAt: new Date() },
              }),
            ]
          : []),
      ]);
      this.logger.warn({
        event: 'chat_moderation.outbox_publish_failed',
        eventId: record.id,
        attempts,
        errorCode: this.errorCode(error),
      });
    }
  }

  private claimableWhere(now: Date, staleAt: Date) {
    return {
      OR: [
        {
          status: {
            in: [ModerationOutboxStatus.PENDING, ModerationOutboxStatus.RETRY],
          },
          nextAttemptAt: { lte: now },
        },
        {
          status: ModerationOutboxStatus.PUBLISHING,
          lockedAt: { lt: staleAt },
        },
      ],
    };
  }

  private async cleanupPublished() {
    const now = Date.now();
    if (now - this.lastCleanupAt < 60 * 60 * 1000) return;
    this.lastCleanupAt = now;
    const retentionDays = this.config.get<number>(
      'rabbitmq.moderationOutboxRetentionDays',
      7,
    );
    await this.prisma.moderationOutbox.deleteMany({
      where: {
        status: ModerationOutboxStatus.PUBLISHED,
        publishedAt: {
          lt: new Date(now - retentionDays * 24 * 60 * 60 * 1000),
        },
      },
    });
  }

  private shouldRun() {
    const enabled = this.config.get<boolean>(
      'rabbitmq.chatModerationPublisherEnabled',
      true,
    );
    const mode = this.config.get<ChatModerationMode>(
      'ai.moderationMode',
      'async',
    );
    return enabled && (mode === 'async' || mode === 'shadow');
  }

  private retryDelay(attempts: number) {
    return Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
  }

  private errorCode(error: unknown) {
    if (error instanceof Error) return error.name || 'ERROR';
    return 'UNKNOWN_ERROR';
  }
}
