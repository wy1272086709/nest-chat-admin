import { ForbiddenException, Injectable } from '@nestjs/common';
import { ChatRestrictionStatus } from '@prisma/client';
import { PrismaService } from '@/common/database/services/prisma.service';

export class ChatUserMutedException extends ForbiddenException {
  constructor(expiresAt: Date) {
    super(`你已被暂时禁言至 ${expiresAt.toISOString()}`);
  }
}

@Injectable()
export class ChatRestrictionService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanSend(userId: string) {
    const restriction = await this.prisma.chatUserRestriction.findFirst({
      where: {
        userId,
        type: 'MUTE',
        status: ChatRestrictionStatus.ACTIVE,
        startsAt: { lte: new Date() },
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'desc' },
      select: { expiresAt: true },
    });
    if (restriction) throw new ChatUserMutedException(restriction.expiresAt);
  }
}
