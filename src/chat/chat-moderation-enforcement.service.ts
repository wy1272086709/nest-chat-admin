import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ChatRestrictionStatus } from '@prisma/client';
import { PrismaService } from '@/common/database/services/prisma.service';
import { ChatGateway } from './chat.gateway';
import { ModerationResult } from './chat-moderation.service';
import { MessageModerationRequestedV1 } from './chat-moderation.types';

@Injectable()
export class ChatModerationEnforcementService {
  private readonly logger = new Logger(ChatModerationEnforcementService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  async handleRejected(
    event: MessageModerationRequestedV1,
    result: ModerationResult,
  ) {
    if (!this.config.get<boolean>('ai.moderationEnforcementEnabled', false)) {
      return;
    }

    const moderation = await this.prisma.messageModeration.findUnique({
      where: { eventId: event.eventId },
      select: { id: true },
    });
    if (!moderation) return;

    const severity = this.severity(result.confidence);
    const score = severity;
    const existingViolation = await this.prisma.userViolation.findUnique({
      where: { moderationId: moderation.id },
      select: { action: true },
    });
    if (existingViolation?.action) return;
    try {
      if (!existingViolation) {
        await this.prisma.userViolation.create({
          data: {
            userId: event.userId,
            messageId: event.messageId,
            moderationId: moderation.id,
            category: result.categories[0] ?? 'unspecified',
            severity,
            score,
            policyVersion: event.policyVersion,
          },
        });
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // 违规记录已存在时继续计算并补齐可能尚未完成的后置动作。
      } else {
        throw error;
      }
    }

    const windowMs = this.config.get<number>(
      'ai.moderationViolationWindowMs',
      86400000,
    );
    const aggregate = await this.prisma.userViolation.aggregate({
      where: {
        userId: event.userId,
        createdAt: { gte: new Date(Date.now() - windowMs) },
      },
      _sum: { score: true },
    });
    const totalScore = aggregate._sum.score ?? 0;
    const muteScore = this.config.get<number>('ai.moderationMuteScore', 6);
    const warningScore = this.config.get<number>(
      'ai.moderationWarningScore',
      3,
    );

    if (totalScore >= muteScore) {
      const expiresAt = new Date(
        Date.now() +
          this.config.get<number>('ai.moderationMuteDurationMs', 600000),
      );
      await this.prisma.chatUserRestriction.upsert({
        where: { sourceModerationId: moderation.id },
        create: {
          userId: event.userId,
          type: 'MUTE',
          status: ChatRestrictionStatus.ACTIVE,
          expiresAt,
          reason: '短时间内多次发送违规内容',
          sourceModerationId: moderation.id,
        },
        update: {},
      });
      await this.prisma.userViolation.update({
        where: { moderationId: moderation.id },
        data: { action: 'MUTE' },
      });
      this.emitToUser(event.userId, 'moderation:restricted', {
        type: 'MUTE',
        expiresAt: expiresAt.toISOString(),
      });
      return;
    }

    if (totalScore >= warningScore) {
      await this.prisma.userViolation.update({
        where: { moderationId: moderation.id },
        data: { action: 'WARNING' },
      });
      this.emitToUser(event.userId, 'moderation:warning', {
        message: '请遵守社区规范，继续发送违规内容可能会被禁言',
        score: totalScore,
      });
    }

    this.logger.log({
      event: 'chat_moderation.enforcement_evaluated',
      userId: event.userId,
      moderationId: moderation.id,
      totalScore,
    });
  }

  private severity(confidence?: number) {
    if (confidence === undefined) return 1;
    if (confidence >= 0.9) return 3;
    if (confidence >= 0.75) return 2;
    return 1;
  }

  private emitToUser(userId: string, event: string, payload: unknown) {
    try {
      this.gateway.emitToUser(userId, event, payload);
    } catch (error) {
      this.logger.error({
        event: 'chat_moderation.enforcement_broadcast_failed',
        userId,
        targetEvent: event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
