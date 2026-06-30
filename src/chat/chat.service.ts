import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MessageType, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/database/services/prisma.service';
import { CreateGroupRoomDto, GetMessagesDto, SendPrivateMessageDto, SendRoomMessageDto } from './dto/chat.dto';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  private getPrivateRoomName(userAId: string, userBId: string) {
    return [userAId, userBId].sort().join(':');
  }

  async assertRoomMember(roomId: string, userId: string) {
    const member = await this.prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
    });

    if (!member || member.status !== 'ACTIVE') {
      throw new ForbiddenException('你不是该房间的成员');
    }

    return member;
  }

  async createGroupRoom(ownerId: string, dto: CreateGroupRoomDto) {
    const memberIds = Array.from(new Set([ownerId, ...(dto.memberIds ?? [])]));

    return this.prisma.chatRoom.create({
      data: {
        name: dto.name,
        description: dto.description,
        topic: 'GROUP',
        createdBy: ownerId,
        ownerId,
        members: {
          create: memberIds.map((userId) => ({
            userId,
            role: userId === ownerId ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      include: {
        members: true,
      },
    });
  }

  async getOrCreatePrivateRoom(senderId: string, receiverId: string) {
    if (senderId === receiverId) {
      throw new ConflictException('不能给自己发送私聊消息');
    }

    const receiver = await this.prisma.chatUser.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });

    if (!receiver) {
      throw new NotFoundException('接收者不存在');
    }

    const name = this.getPrivateRoomName(senderId, receiverId);
    const existingRoom = await this.prisma.chatRoom.findFirst({
      where: {
        topic: 'PRIVATE',
        name,
      },
      include: {
        members: true,
      },
    });

    if (existingRoom) {
      return existingRoom;
    }

    return this.prisma.chatRoom.create({
      data: {
        name,
        topic: 'PRIVATE',
        createdBy: senderId,
        ownerId: senderId,
        members: {
          create: [
            {
              userId: senderId,
              role: 'OWNER',
            },
            {
              userId: receiverId,
              role: 'MEMBER',
            },
          ],
        },
      },
      include: {
        members: true,
      },
    });
  }

  async getRoomMemberIds(roomId: string) {
    const members = await this.prisma.roomMember.findMany({
      where: {
        roomId,
        status: 'ACTIVE',
      },
      select: {
        userId: true,
      },
    });

    return members.map((member) => member.userId);
  }

  async sendRoomMessage(senderId: string, dto: SendRoomMessageDto) {
    await this.assertRoomMember(dto.roomId, senderId);

    return this.prisma.message.create({
      data: {
        roomId: dto.roomId,
        senderId,
        content: dto.content,
        messageType: dto.messageType ?? MessageType.TEXT,
        fileUrl: dto.fileUrl,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        fileType: dto.fileType,
        thumbnailUrl: dto.thumbnailUrl,
        mediaWidth: dto.mediaWidth,
        mediaHeight: dto.mediaHeight,
        duration: dto.duration,
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatarUrl: true,
          },
        },
        room: {
          select: {
            id: true,
            name: true,
            topic: true,
          },
        },
      },
    });
  }

  async sendPrivateMessage(senderId: string, dto: SendPrivateMessageDto) {
    const room = await this.getOrCreatePrivateRoom(senderId, dto.receiverId);
    const message = await this.sendRoomMessage(senderId, {
      roomId: room.id,
      content: dto.content,
      messageType: dto.messageType,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileSize: dto.fileSize,
      fileType: dto.fileType,
    });

    return {
      room,
      message,
    };
  }

  async getMessages(userId: string, dto: GetMessagesDto) {
    await this.assertRoomMember(dto.roomId, userId);

    const clearState = await this.prisma.chatClearState.findUnique({
      where: {
        roomId_userId: {
          roomId: dto.roomId,
          userId,
        },
      },
    });

    return this.prisma.message.findMany({
      where: {
        roomId: dto.roomId,
        isDeleted: false,
        createdAt: clearState ? { gt: clearState.clearedAt } : undefined,
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: dto.take ?? 50,
    });
  }

  async markRoomRead(userId: string, roomId: string) {
    await this.assertRoomMember(roomId, userId);

    return this.prisma.roomMember.update({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
      data: {
        lastReadAt: new Date(),
      },
    });
  }

  async clearRoom(userId: string, roomId: string) {
    await this.assertRoomMember(roomId, userId);

    return this.prisma.chatClearState.upsert({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
      create: {
        roomId,
        userId,
      },
      update: {
        clearedAt: new Date(),
      },
    });
  }

  /**
   * 获取当前用户的会话列表（群聊 + 私聊）。
   * 每个会话附带：最后一条消息、未读数（同时考虑 lastReadAt 与 clearedAt）。
   * 说明：为保持简单，这里对每个会话单独查未读数（会话数通常不大）；
   * 后续会话量变大可改成一次 groupBy 批量聚合。
   */
  async listConversations(userId: string) {
    const memberships = await this.prisma.roomMember.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        room: {
          include: {
            members: {
              where: { status: 'ACTIVE' },
              include: {
                user: {
                  select: { id: true, username: true, nickname: true, avatarUrl: true },
                },
              },
            },
          },
        },
      },
      orderBy: { room: { updatedAt: 'desc' } },
    });

    const conversations = await Promise.all(
      memberships.map(async (membership) => {
        const clearState = await this.prisma.chatClearState.findUnique({
          where: { roomId_userId: { roomId: membership.roomId, userId } },
        });

        // 未读阈值：取「上次已读时间」与「清空时间」中较晚者，
        // 只有晚于该阈值、且不是自己发的、未删除的消息才算未读。
        const thresholds: number[] = [];
        if (membership.lastReadAt) thresholds.push(membership.lastReadAt.getTime());
        if (clearState) thresholds.push(clearState.clearedAt.getTime());
        const unreadSince = thresholds.length ? new Date(Math.max(...thresholds)) : null;

        const unreadWhere: Prisma.MessageWhereInput = {
          roomId: membership.roomId,
          senderId: { not: userId },
          isDeleted: false,
        };
        if (unreadSince) {
          unreadWhere.createdAt = { gt: unreadSince };
        }

        const [lastMessage, unreadCount] = await Promise.all([
          this.prisma.message.findFirst({
            where: {
              roomId: membership.roomId,
              isDeleted: false,
              createdAt: clearState ? { gt: clearState.clearedAt } : undefined,
            },
            orderBy: { createdAt: 'desc' },
            include: {
              sender: {
                select: { id: true, username: true, nickname: true, avatarUrl: true },
              },
            },
          }),
          this.prisma.message.count({ where: unreadWhere }),
        ]);

        return {
          room: membership.room,
          role: membership.role,
          lastReadAt: membership.lastReadAt,
          clearedAt: clearState?.clearedAt ?? null,
          lastMessage,
          unreadCount,
        };
      }),
    );

    return conversations;
  }

  /** 获取某个聊天室的成员列表（调用前会校验调用者是否为该室成员） */
  async getRoomMembers(roomId: string, userId: string) {
    await this.assertRoomMember(roomId, userId);

    return this.prisma.roomMember.findMany({
      where: { roomId, status: 'ACTIVE' },
      include: {
        user: {
          select: { id: true, username: true, nickname: true, avatarUrl: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }
}
