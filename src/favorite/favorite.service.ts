import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FavoriteType, MessageType, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/database/services/prisma.service';
import { CreateFavoriteDto, FavoriteQueryDto, RemoveFavoriteDto } from './dto/favorite.dto';

const messageTypeByFavoriteType: Partial<Record<FavoriteType, MessageType>> = {
  [FavoriteType.MESSAGE]: MessageType.TEXT,
  [FavoriteType.IMAGE]: MessageType.IMAGE,
  [FavoriteType.VIDEO]: MessageType.VIDEO,
  [FavoriteType.FILE]: MessageType.FILE,
};

@Injectable()
export class FavoriteService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: FavoriteQueryDto) {
    return this.prisma.favorite.findMany({
      where: {
        userId,
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: {
        collectedAt: 'desc',
      },
      take: query.take ?? 100,
    });
  }

  async create(userId: string, dto: CreateFavoriteDto) {
    const data = await this.buildCreateData(userId, dto);

    try {
      return await this.prisma.favorite.create({
        data,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该内容已收藏');
      }
      throw error;
    }
  }

  async remove(userId: string, dto: RemoveFavoriteDto) {
    const favorite = await this.prisma.favorite.findUnique({
      where: {
        userId_type_targetId: {
          userId,
          type: dto.type,
          targetId: dto.targetId,
        },
      },
    });

    if (!favorite) {
      throw new NotFoundException('收藏不存在');
    }

    await this.prisma.favorite.delete({
      where: {
        id: favorite.id,
      },
    });

    return favorite;
  }

  private async buildCreateData(userId: string, dto: CreateFavoriteDto): Promise<Prisma.FavoriteUncheckedCreateInput> {
    if (dto.type === FavoriteType.CHAT_RECORD) {
      return this.buildChatRecordFavoriteData(userId, dto);
    }

    return this.buildMessageFavoriteData(userId, dto);
  }

  private async buildMessageFavoriteData(
    userId: string,
    dto: CreateFavoriteDto,
  ): Promise<Prisma.FavoriteUncheckedCreateInput> {
    const message = await this.prisma.message.findUnique({
      where: { id: dto.targetId },
      include: {
        room: {
          select: {
            id: true,
            name: true,
            topic: true,
          },
        },
        sender: {
          select: {
            username: true,
            nickname: true,
          },
        },
      },
    });

    if (!message || message.isDeleted) {
      throw new NotFoundException('收藏目标不存在');
    }

    await this.assertActiveRoomMember(message.roomId, userId);

    if (dto.roomId && dto.roomId !== message.roomId) {
      throw new BadRequestException('收藏目标与房间不匹配');
    }

    const expectedMessageType = messageTypeByFavoriteType[dto.type];
    if (expectedMessageType && message.messageType !== expectedMessageType) {
      throw new BadRequestException('收藏类型与消息类型不匹配');
    }

    return {
      userId,
      type: dto.type,
      targetId: message.id,
      sourceType: dto.sourceType ?? this.getRoomSourceType(message.room.topic),
      sourceId: dto.sourceId ?? message.roomId,
      sourceName: dto.sourceName ?? message.room.name,
      roomId: message.roomId,
      title: dto.title ?? this.getMessageFavoriteTitle(message),
      content: message.content,
      fileUrl: message.fileUrl,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      thumbnailUrl: message.thumbnailUrl,
      mediaWidth: message.mediaWidth,
      mediaHeight: message.mediaHeight,
      duration: message.duration,
      extra: dto.extra as Prisma.InputJsonValue | undefined,
    };
  }

  private async buildChatRecordFavoriteData(
    userId: string,
    dto: CreateFavoriteDto,
  ): Promise<Prisma.FavoriteUncheckedCreateInput> {
    const roomId = dto.roomId ?? dto.targetId;
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        name: true,
        topic: true,
      },
    });

    if (!room) {
      throw new NotFoundException('收藏目标不存在');
    }

    await this.assertActiveRoomMember(room.id, userId);
    await this.assertChatRecordMessagesBelongToRoom(dto.extra, room.id);

    return {
      userId,
      type: dto.type,
      targetId: dto.targetId,
      sourceType: dto.sourceType ?? this.getRoomSourceType(room.topic),
      sourceId: dto.sourceId ?? room.id,
      sourceName: dto.sourceName ?? room.name,
      roomId: room.id,
      title: dto.title ?? room.name,
      content: dto.content,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileSize: dto.fileSize,
      fileType: dto.fileType,
      thumbnailUrl: dto.thumbnailUrl,
      mediaWidth: dto.mediaWidth,
      mediaHeight: dto.mediaHeight,
      duration: dto.duration,
      extra: dto.extra as Prisma.InputJsonValue | undefined,
    };
  }

  private async assertActiveRoomMember(roomId: string, userId: string) {
    const member = await this.prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
      select: {
        status: true,
      },
    });

    if (!member || member.status !== 'ACTIVE') {
      throw new ForbiddenException('无权收藏该内容');
    }
  }

  private async assertChatRecordMessagesBelongToRoom(extra: Record<string, unknown> | undefined, roomId: string) {
    const messageIds = Array.isArray(extra?.messageIds)
      ? extra.messageIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (!messageIds.length) {
      return;
    }

    const uniqueMessageIds = Array.from(new Set(messageIds));
    const count = await this.prisma.message.count({
      where: {
        id: {
          in: uniqueMessageIds,
        },
        roomId,
        isDeleted: false,
      },
    });

    if (count !== uniqueMessageIds.length) {
      throw new BadRequestException('聊天记录包含不可收藏的消息');
    }
  }

  private getRoomSourceType(topic: string | null) {
    return topic === 'PRIVATE' ? 'private' : 'group';
  }

  private getMessageFavoriteTitle(
    message: Prisma.MessageGetPayload<{
      include: {
        sender: {
          select: {
            username: true;
            nickname: true;
          };
        };
      };
    }>,
  ) {
    const senderName = message.sender.nickname || message.sender.username;

    if (message.messageType === MessageType.TEXT) {
      return senderName;
    }

    return message.fileName || senderName;
  }
}
