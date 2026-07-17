import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/database/services/prisma.service';
import { ChatGateway } from './chat.gateway';
import { ModerationResult } from './chat-moderation.service';
import {
  ChatModerationMode,
  MessageModerationRequestedV1,
} from './chat-moderation.types';
import { ChatModerationEnforcementService } from './chat-moderation-enforcement.service';

@Injectable()
export class ChatModerationActionService {
  private readonly logger = new Logger(ChatModerationActionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
    private readonly enforcement: ChatModerationEnforcementService,
  ) {}

  async apply(event: MessageModerationRequestedV1, result: ModerationResult) {
    if (result.decision !== 'REJECT' || !this.actionsEnabled()) return;

    const deletedAt = new Date();
    const updated = await this.prisma.message.updateMany({
      where: { id: event.messageId, isDeleted: false },
      data: { isDeleted: true, deletedAt },
    });
    if (updated.count === 1) {
      const members = await this.prisma.roomMember.findMany({
        where: { roomId: event.roomId, status: 'ACTIVE' },
        select: { userId: true },
      });
      const payload = {
        messageId: event.messageId,
        roomId: event.roomId,
        status: 'REJECTED',
        moderatedAt: deletedAt.toISOString(),
      };
      try {
        this.gateway.emitToUsers(
          members.map((member) => member.userId),
          'message:moderated',
          payload,
        );
      } catch (error) {
        // 数据库可见性是事实来源；实时通知失败时客户端会在下次同步时收敛。
        this.logger.error({
          event: 'chat_moderation.broadcast_failed',
          messageId: event.messageId,
          roomId: event.roomId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.enforcement.handleRejected(event, result);
  }

  private actionsEnabled() {
    const mode = this.config.get<ChatModerationMode>(
      'ai.moderationMode',
      'async',
    );
    return (
      mode === 'async' &&
      this.config.get<boolean>('ai.moderationActionsEnabled', false)
    );
  }
}
