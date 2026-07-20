import { HttpStatus, Injectable } from "@nestjs/common";
import { MessageType, Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PrismaService } from "@/common/database/services/prisma.service";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";
import {
  ChatModerationService,
  MessageModerationRejectedException,
  ModerationResult,
} from "./chat-moderation.service";
import {
  CHAT_MODERATION_EVENT_TYPE,
  CHAT_MODERATION_EVENT_VERSION,
  ChatModerationMode,
  MessageModerationRequestedV1,
} from "./chat-moderation.types";
import { ChatRestrictionService } from "./chat-restriction.service";
import {
  CreateGroupRoomDto,
  DeliveredMessageDto,
  GetMessagesDto,
  SendPrivateMessageDto,
  SendRoomMessageDto,
  SyncMessagesDto,
} from "./dto/chat.dto";

const messageInclude = {
  sender: {
    select: {
      id: true,
      username: true,
      nickname: true,
      avatarUrl: true,
      lastLoginAt: true,
      lastSeenAt: true,
    },
  },
  room: {
    select: {
      id: true,
      name: true,
      topic: true,
    },
  },
} satisfies Prisma.MessageInclude;

type ChatMessagePayload = Prisma.MessageGetPayload<{
  include: typeof messageInclude;
}>;

type SendMessageResult = {
  message: ChatMessagePayload;
  isDuplicate: boolean;
};

type ConversationSnapshotRow = {
  roomId: string;
  clearedAt: Date | null;
  lastMessageId: string | null;
  unreadCount: number;
};

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderationService: ChatModerationService,
    private readonly config: ConfigService,
    private readonly restrictions: ChatRestrictionService,
  ) {}

  private getPrivateRoomName(userAId: string, userBId: string) {
    return [userAId, userBId].sort().join(":");
  }

  async updateUserLastSeen(userId: string, lastSeenAt = new Date()) {
    await this.prisma.chatUser.update({
      where: { id: userId },
      data: { lastSeenAt },
    });
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

    if (!member || member.status !== "ACTIVE") {
      throw new BusinessException(
        BusinessErrorCode.CHAT_NOT_ROOM_MEMBER,
        "你不是该房间的成员",
        HttpStatus.FORBIDDEN,
      );
    }

    return member;
  }

  async createGroupRoom(ownerId: string, dto: CreateGroupRoomDto) {
    const memberIds = Array.from(new Set([ownerId, ...(dto.memberIds ?? [])]));

    return this.prisma.chatRoom.create({
      data: {
        name: dto.name,
        description: dto.description,
        topic: "GROUP",
        createdBy: ownerId,
        ownerId,
        members: {
          create: memberIds.map((userId) => ({
            userId,
            role: userId === ownerId ? "OWNER" : "MEMBER",
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
      throw new BusinessException(
        BusinessErrorCode.CHAT_PRIVATE_SELF_FORBIDDEN,
        "不能给自己发送私聊消息",
        HttpStatus.BAD_REQUEST,
      );
    }

    const receiver = await this.prisma.chatUser.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });

    if (!receiver) {
      throw new BusinessException(
        BusinessErrorCode.CHAT_RECEIVER_NOT_FOUND,
        "接收者不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    const name = this.getPrivateRoomName(senderId, receiverId);
    const existingRoom = await this.prisma.chatRoom.findFirst({
      where: {
        topic: "PRIVATE",
        name,
      },
      include: {
        members: true,
      },
    });

    if (existingRoom) {
      // 恢复双方成员状态：删除好友会把发起方在该私聊置为 INACTIVE，
      // 重新发起私聊时需重新激活，否则 assertRoomMember 会在发消息时抛 403。
      await this.prisma.roomMember.updateMany({
        where: {
          roomId: existingRoom.id,
          userId: { in: [senderId, receiverId] },
        },
        data: { status: "ACTIVE" },
      });
      return existingRoom;
    }

    return this.prisma.chatRoom.create({
      data: {
        name,
        topic: "PRIVATE",
        createdBy: senderId,
        ownerId: senderId,
        members: {
          create: [
            {
              userId: senderId,
              role: "OWNER",
            },
            {
              userId: receiverId,
              role: "MEMBER",
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
        status: "ACTIVE",
      },
      select: {
        userId: true,
      },
    });

    return members.map((member) => member.userId);
  }

  async sendRoomMessage(
    senderId: string,
    dto: SendRoomMessageDto,
  ): Promise<SendMessageResult> {
    await this.assertRoomMember(dto.roomId, senderId);

    const existingMessage = await this.findIdempotentMessage(
      senderId,
      dto.clientMessageId,
    );
    if (existingMessage) {
      if (existingMessage.roomId !== dto.roomId) {
        throw new BusinessException(
          BusinessErrorCode.CHAT_MESSAGE_ID_CONFLICT,
          "客户端消息ID已被用于其他会话",
          HttpStatus.CONFLICT,
        );
      }

      return {
        message: existingMessage,
        isDuplicate: true,
      };
    }

    await this.restrictions.assertCanSend(senderId);

    if (
      await this.moderationService.wasRejected(senderId, dto.clientMessageId)
    ) {
      throw new MessageModerationRejectedException();
    }

    const moderationMode = this.getModerationMode();
    let moderation: ModerationResult | undefined;
    const messageType = dto.messageType ?? MessageType.TEXT;
    if (
      moderationMode === "sync" &&
      messageType === MessageType.TEXT &&
      dto.content?.trim()
    ) {
      moderation = await this.moderationService.moderate({
        content: dto.content,
        userId: senderId,
        roomId: dto.roomId,
      });
      if (moderation.decision === "REJECT") {
        await this.moderationService.recordResult({
          userId: senderId,
          roomId: dto.roomId,
          clientMessageId: dto.clientMessageId,
          result: moderation,
        });
        throw new MessageModerationRejectedException();
      }
    }

    try {
      const shouldQueueModeration =
        (moderationMode === "async" || moderationMode === "shadow") &&
        messageType === MessageType.TEXT &&
        Boolean(dto.content?.trim());
      const eventId = shouldQueueModeration ? randomUUID() : undefined;
      const policyVersion = this.config.get<string>(
        "ai.moderationPolicyVersion",
        "v1",
      );
      const message = await this.prisma.$transaction(async (tx) => {
        const createdMessage = await tx.message.create({
          data: {
            roomId: dto.roomId,
            senderId,
            clientMessageId: dto.clientMessageId,
            content: dto.content,
            messageType,
            fileUrl: dto.fileUrl,
            fileName: dto.fileName,
            fileSize: dto.fileSize,
            fileType: dto.fileType,
            thumbnailUrl: dto.thumbnailUrl,
            mediaWidth: dto.mediaWidth,
            mediaHeight: dto.mediaHeight,
            duration: dto.duration,
            moderationStatus: shouldQueueModeration
              ? "PENDING"
              : this.getSynchronousModerationStatus(moderation),
            moderatedAt: moderation ? new Date() : undefined,
          },
          include: messageInclude,
        });

        if (eventId) {
          const event: MessageModerationRequestedV1 = {
            eventId,
            eventType: CHAT_MODERATION_EVENT_TYPE,
            version: CHAT_MODERATION_EVENT_VERSION,
            messageId: createdMessage.id,
            userId: senderId,
            roomId: dto.roomId,
            requestedAt: new Date().toISOString(),
            policyVersion,
          };
          await tx.moderationOutbox.create({
            data: {
              id: eventId,
              eventType: CHAT_MODERATION_EVENT_TYPE,
              aggregateId: createdMessage.id,
              payload: event,
            },
          });
        }

        return createdMessage;
      });

      if (moderation) {
        await this.moderationService.recordResult({
          userId: senderId,
          roomId: dto.roomId,
          messageId: message.id,
          clientMessageId: dto.clientMessageId,
          result: moderation,
        });
      }

      return {
        message,
        isDuplicate: false,
      };
    } catch (error) {
      if (
        dto.clientMessageId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const retryMessage = await this.findIdempotentMessage(
          senderId,
          dto.clientMessageId,
        );
        if (retryMessage) {
          return {
            message: retryMessage,
            isDuplicate: true,
          };
        }
      }

      throw error;
    }
  }

  async sendPrivateMessage(senderId: string, dto: SendPrivateMessageDto) {
    const room = await this.getOrCreatePrivateRoom(senderId, dto.receiverId);
    // 与群聊一致：透传全部媒体字段（缩略图/宽高/时长），避免私聊图片/文件消息丢失元数据
    const sendResult = await this.sendRoomMessage(senderId, {
      roomId: room.id,
      content: dto.content,
      clientMessageId: dto.clientMessageId,
      messageType: dto.messageType,
      fileUrl: dto.fileUrl,
      fileName: dto.fileName,
      fileSize: dto.fileSize,
      fileType: dto.fileType,
      thumbnailUrl: dto.thumbnailUrl,
      mediaWidth: dto.mediaWidth,
      mediaHeight: dto.mediaHeight,
      duration: dto.duration,
    });

    return {
      room,
      message: sendResult.message,
      isDuplicate: sendResult.isDuplicate,
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
        createdAt: "desc",
      },
      take: dto.take ?? 50,
    });
  }

  async syncMessages(userId: string, dto: SyncMessagesDto) {
    await this.assertRoomMember(dto.roomId, userId);

    const take = dto.take ?? 50;
    let messages: ChatMessagePayload[];

    if (dto.afterMessageId) {
      const cursorMessage = await this.prisma.message.findFirst({
        where: {
          id: dto.afterMessageId,
          roomId: dto.roomId,
          isDeleted: false,
        },
        select: {
          id: true,
        },
      });

      if (!cursorMessage) {
        throw new BusinessException(
          BusinessErrorCode.CHAT_SYNC_CURSOR_NOT_FOUND,
          "同步游标消息不存在",
          HttpStatus.NOT_FOUND,
        );
      }

      messages = await this.prisma.message.findMany({
        where: {
          roomId: dto.roomId,
          isDeleted: false,
        },
        cursor: {
          id: dto.afterMessageId,
        },
        skip: 1,
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
        take,
        include: messageInclude,
      });
    } else {
      const recentMessages = await this.prisma.message.findMany({
        where: {
          roomId: dto.roomId,
          isDeleted: false,
        },
        orderBy: [
          {
            createdAt: "desc",
          },
          {
            id: "desc",
          },
        ],
        take,
        include: messageInclude,
      });

      messages = recentMessages.reverse();
    }

    const lastMessage = messages[messages.length - 1] ?? null;
    if (lastMessage) {
      await this.upsertDeliveredState(
        userId,
        dto.roomId,
        lastMessage.id,
        lastMessage.createdAt,
      );
    }

    return {
      messages,
      nextCursor: lastMessage
        ? {
            messageId: lastMessage.id,
            createdAt: lastMessage.createdAt,
          }
        : null,
      hasMore: messages.length === take,
    };
  }

  async markMessageDelivered(userId: string, dto: DeliveredMessageDto) {
    await this.assertRoomMember(dto.roomId, userId);

    const message = await this.prisma.message.findFirst({
      where: {
        id: dto.messageId,
        roomId: dto.roomId,
        isDeleted: false,
      },
      select: {
        id: true,
        roomId: true,
        createdAt: true,
      },
    });

    if (!message) {
      throw new BusinessException(
        BusinessErrorCode.CHAT_MESSAGE_NOT_FOUND,
        "消息不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    return this.upsertDeliveredState(
      userId,
      dto.roomId,
      message.id,
      message.createdAt,
    );
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
   * 退出群聊。
   * - 软移除自己（成员状态置 INACTIVE），保留历史消息与成员记录，便于日后重新加入。
   * - 群主退出：自动把群主转让给「最早加入」的剩余 ACTIVE 成员，避免群聊无主。
   * - 最后一名成员退出：归档房间（isArchived = true），等价于解散。
   * 返回结果供 Controller 推送实时事件（member:left / room:left）。
   */
  async leaveRoom(userId: string, roomId: string) {
    // 校验调用者仍是该室 ACTIVE 成员（同时拿到其角色，用于判断是否需要转让群主）
    const member = await this.assertRoomMember(roomId, userId);

    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      select: { id: true, topic: true },
    });
    if (!room) {
      throw new BusinessException(
        BusinessErrorCode.CHAT_ROOM_NOT_FOUND,
        "房间不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    // 软移除自己：与删除好友一致采用 INACTIVE，保留关系记录与历史
    await this.prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status: "INACTIVE" },
    });

    // 剩余 ACTIVE 成员（按加入时间升序，用于群主转让）
    const remaining = await this.prisma.roomMember.findMany({
      where: { roomId, status: "ACTIVE" },
      orderBy: { joinedAt: "asc" },
      select: { userId: true },
    });
    const remainingMemberIds = remaining.map((m) => m.userId);

    let newOwnerId: string | null = null;
    let disbanded = false;

    if (remainingMemberIds.length === 0) {
      // 无人剩留：归档房间（软解散）
      await this.prisma.chatRoom.update({
        where: { id: roomId },
        data: { isArchived: true },
      });
      disbanded = true;
    } else if (member.role === "OWNER") {
      // 群主退出：转让给最早加入的剩余成员
      newOwnerId = remainingMemberIds[0];
      await this.prisma.$transaction([
        this.prisma.roomMember.update({
          where: { roomId_userId: { roomId, userId: newOwnerId } },
          data: { role: "OWNER" },
        }),
        this.prisma.chatRoom.update({
          where: { id: roomId },
          data: { ownerId: newOwnerId },
        }),
      ]);
    }

    return {
      roomId,
      userId,
      disbanded,
      newOwnerId,
      remainingMemberIds,
    };
  }

  /**
   * 邀请成员加入群聊（直接加，与建群一致不走邀请确认流程）。
   * - 校验邀请者仍是该室 ACTIVE 成员。
   * - 对每个被邀请者 upsert 成员记录：新成员创建为 MEMBER/ACTIVE；
   *   曾退出（INACTIVE）的成员重新激活，保留历史消息。
   * 返回最新房间（含成员）与本次新增/激活的用户 ID，供 Controller 推送实时事件。
   */
  async addMembers(inviterId: string, roomId: string, memberIds: string[]) {
    await this.assertRoomMember(roomId, inviterId);

    const room = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      select: { id: true },
    });
    if (!room) {
      throw new BusinessException(
        BusinessErrorCode.CHAT_ROOM_NOT_FOUND,
        "房间不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    // 去重 + 排除邀请者自己
    const targets = Array.from(new Set(memberIds)).filter(
      (id) => id && id !== inviterId,
    );

    if (targets.length > 0) {
      await Promise.all(
        targets.map((userId) =>
          this.prisma.roomMember.upsert({
            where: { roomId_userId: { roomId, userId } },
            create: { roomId, userId, role: "MEMBER", status: "ACTIVE" },
            update: { status: "ACTIVE" },
          }),
        ),
      );
    }

    // 返回最新房间（含成员关系），供 Controller 推送给新成员刷新会话列表
    const updated = await this.prisma.chatRoom.findUnique({
      where: { id: roomId },
      include: { members: true },
    });

    return {
      room: updated,
      addedMemberIds: targets,
    };
  }

  /**
   * 获取当前用户的会话列表（群聊 + 私聊）。
   * 每个会话附带：最后一条消息、未读数（同时考虑 lastReadAt 与 clearedAt）。
   * 会话快照使用一次参数化 SQL 批量计算，避免按会话逐个查询产生 N+1。
   */
  async listConversations(userId: string) {
    const memberships = await this.prisma.roomMember.findMany({
      where: { userId, status: "ACTIVE" },
      include: {
        room: {
          include: {
            members: {
              where: { status: "ACTIVE" },
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    nickname: true,
                    avatarUrl: true,
                    lastLoginAt: true,
                    lastSeenAt: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { room: { updatedAt: "desc" } },
    });

    if (memberships.length === 0) return [];

    const snapshots = await this.prisma.$queryRaw<ConversationSnapshotRow[]>(
      Prisma.sql`
        SELECT
          rm."roomId" AS "roomId",
          cs."clearedAt" AS "clearedAt",
          (
            SELECT m.id
            FROM "chat_messages" m
            WHERE m."roomId" = rm."roomId"
              AND m."isDeleted" = false
              AND (cs."clearedAt" IS NULL OR m."createdAt" > cs."clearedAt")
            ORDER BY m."createdAt" DESC
            LIMIT 1
          ) AS "lastMessageId",
          (
            SELECT COUNT(*)::int
            FROM "chat_messages" m
            WHERE m."roomId" = rm."roomId"
              AND m."senderId" <> ${userId}
              AND m."isDeleted" = false
              AND m."createdAt" > GREATEST(
                COALESCE(rm."lastReadAt", '-infinity'::timestamp),
                COALESCE(cs."clearedAt", '-infinity'::timestamp)
              )
          ) AS "unreadCount"
        FROM "chat_room_members" rm
        LEFT JOIN "chat_clear_states" cs
          ON cs."roomId" = rm."roomId" AND cs."userId" = rm."userId"
        WHERE rm."userId" = ${userId}
          AND rm.status = 'ACTIVE'
      `,
    );

    const snapshotByRoomId = new Map(
      snapshots.map((snapshot) => [snapshot.roomId, snapshot]),
    );
    const lastMessageIds = snapshots.flatMap((snapshot) =>
      snapshot.lastMessageId ? [snapshot.lastMessageId] : [],
    );
    const lastMessages = await this.prisma.message.findMany({
      where: { id: { in: lastMessageIds } },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatarUrl: true,
            lastLoginAt: true,
            lastSeenAt: true,
          },
        },
      },
    });
    const lastMessageById = new Map(
      lastMessages.map((message) => [message.id, message]),
    );

    return memberships.map((membership) => {
      const snapshot = snapshotByRoomId.get(membership.roomId);

      return {
        room: membership.room,
        role: membership.role,
        lastReadAt: membership.lastReadAt,
        clearedAt: snapshot?.clearedAt ?? null,
        lastMessage: snapshot?.lastMessageId
          ? (lastMessageById.get(snapshot.lastMessageId) ?? null)
          : null,
        unreadCount: snapshot?.unreadCount ?? 0,
      };
    });
  }

  /** 获取某个聊天室的成员列表（调用前会校验调用者是否为该室成员） */
  async getRoomMembers(roomId: string, userId: string) {
    await this.assertRoomMember(roomId, userId);

    return this.prisma.roomMember.findMany({
      where: { roomId, status: "ACTIVE" },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            nickname: true,
            avatarUrl: true,
            lastLoginAt: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
  }

  private async findIdempotentMessage(
    senderId: string,
    clientMessageId?: string,
  ) {
    if (!clientMessageId) {
      return null;
    }

    return this.prisma.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId,
          clientMessageId,
        },
      },
      include: messageInclude,
    });
  }

  private getModerationMode(): ChatModerationMode {
    if (!this.config.get<boolean>("ai.moderationEnabled", true)) return "off";
    return this.config.get<ChatModerationMode>("ai.moderationMode", "async");
  }

  private getSynchronousModerationStatus(moderation?: ModerationResult) {
    if (!moderation) return "NOT_APPLICABLE" as const;
    if (moderation.decision === "PASS") return "PASSED" as const;
    if (moderation.decision === "REVIEW") return "REVIEW" as const;
    return "DEGRADED" as const;
  }

  private async upsertDeliveredState(
    userId: string,
    roomId: string,
    messageId: string,
    deliveredAt: Date,
  ) {
    const existingState = await this.prisma.messageSyncState.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
    });

    if (
      existingState?.lastDeliveredAt &&
      existingState.lastDeliveredAt.getTime() > deliveredAt.getTime()
    ) {
      return existingState;
    }

    if (
      existingState?.lastDeliveredAt &&
      existingState.lastDeliveredAt.getTime() === deliveredAt.getTime() &&
      existingState.lastDeliveredId === messageId
    ) {
      return existingState;
    }

    return this.prisma.messageSyncState.upsert({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
      create: {
        roomId,
        userId,
        lastDeliveredId: messageId,
        lastDeliveredAt: deliveredAt,
      },
      update: {
        lastDeliveredId: messageId,
        lastDeliveredAt: deliveredAt,
      },
    });
  }
}
