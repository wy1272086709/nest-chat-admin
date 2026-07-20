import { HttpStatus, Injectable } from "@nestjs/common";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";
import { ChatRestrictionStatus } from "@prisma/client";
import { PrismaService } from "@/common/database/services/prisma.service";

export class ChatUserMutedException extends BusinessException {
  constructor(expiresAt: Date) {
    super(
      BusinessErrorCode.CHAT_USER_MUTED,
      `你已被暂时禁言至 ${expiresAt.toISOString()}`,
      HttpStatus.FORBIDDEN,
    );
  }
}

@Injectable()
export class ChatRestrictionService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanSend(userId: string) {
    const restriction = await this.prisma.chatUserRestriction.findFirst({
      where: {
        userId,
        type: "MUTE",
        status: ChatRestrictionStatus.ACTIVE,
        startsAt: { lte: new Date() },
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: "desc" },
      select: { expiresAt: true },
    });
    if (restriction) throw new ChatUserMutedException(restriction.expiresAt);
  }
}
