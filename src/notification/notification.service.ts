import { HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/database/services/prisma.service";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";
import {
  FriendRequestAction,
  HandleFriendRequestDto,
} from "./dto/notification.dto";

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly notificationSenderSelect = {
    id: true,
    username: true,
    nickname: true,
    email: true,
    avatarUrl: true,
  } as const;

  private getFriendshipPair(userId: string, friendId: string) {
    return [userId, friendId].sort() as [string, string];
  }

  /**
   * 获取当前用户收到的所有通知，包括好友申请、群聊邀请等。
   */
  async findReceived(userId: string) {
    return this.prisma.notification.findMany({
      where: {
        receiverId: userId,
      },
      include: {
        sender: {
          select: this.notificationSenderSelect,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async findFriendRequests(userId: string) {
    return this.prisma.notification.findMany({
      where: {
        receiverId: userId,
        type: "FRIEND_REQUEST",
      },
      include: {
        sender: {
          select: this.notificationSenderSelect,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async markRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new BusinessException(
        BusinessErrorCode.NOTIFICATION_NOT_FOUND,
        "通知不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    if (notification.receiverId !== userId) {
      throw new BusinessException(
        BusinessErrorCode.NOTIFICATION_FORBIDDEN,
        "只能操作自己的通知",
        HttpStatus.FORBIDDEN,
      );
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
      },
      include: {
        sender: {
          select: this.notificationSenderSelect,
        },
      },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: {
        receiverId: userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
  }

  async handleFriendRequest(userId: string, handleDto: HandleFriendRequestDto) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: handleDto.notificationId },
    });

    if (!notification || notification.type !== "FRIEND_REQUEST") {
      throw new BusinessException(
        BusinessErrorCode.FRIEND_REQUEST_NOT_FOUND,
        "好友申请不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    if (notification.receiverId !== userId) {
      throw new BusinessException(
        BusinessErrorCode.FRIEND_REQUEST_FORBIDDEN,
        "只能处理发送给自己的好友申请",
        HttpStatus.FORBIDDEN,
      );
    }

    if (notification.result !== "PENDING") {
      throw new BusinessException(
        BusinessErrorCode.FRIEND_REQUEST_ALREADY_HANDLED,
        "该好友申请已处理",
        HttpStatus.CONFLICT,
      );
    }

    if (handleDto.action === FriendRequestAction.REJECTED) {
      return this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          result: "REJECTED",
          isRead: true,
        },
        include: {
          sender: {
            select: this.notificationSenderSelect,
          },
        },
      });
    }

    const [userAId, userBId] = this.getFriendshipPair(
      notification.senderId,
      notification.receiverId,
    );

    return this.prisma.$transaction(async (tx) => {
      const existingFriendship = await tx.chatFriendship.findUnique({
        where: {
          senderId_receiverId: {
            senderId: userAId,
            receiverId: userBId,
          },
        },
      });

      if (!existingFriendship) {
        await tx.chatFriendship.create({
          data: {
            senderId: userAId,
            receiverId: userBId,
          },
        });
      }

      return tx.notification.update({
        where: { id: notification.id },
        data: {
          result: "ACCEPTED",
          isRead: true,
        },
        include: {
          sender: {
            select: this.notificationSenderSelect,
          },
        },
      });
    });
  }
}
