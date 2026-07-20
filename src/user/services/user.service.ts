import {
  Injectable,
  ConflictException,
  NotFoundException,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../common/database/services/prisma.service";
import * as bcrypt from "bcryptjs";
import { ChatUser, Prisma, UserStatus } from "@prisma/client";
import { AddFriendDto, LoginDto } from "../dto/user.dto";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly prisma: PrismaService) {}

  private getFriendshipPair(userId: string, friendId: string) {
    return [userId, friendId].sort() as [string, string];
  }

  async create(
    userData: Partial<ChatUser> & { password: string },
  ): Promise<Pick<ChatUser, "username" | "email" | "nickname">> {
    const passwordHash = await bcrypt.hash(userData.password, 10);

    try {
      return await this.prisma.chatUser.create({
        data: {
          username: userData.username!,
          email: userData.email!,
          nickname: userData.nickname!,
          passwordHash,
          status: "ACTIVE",
        },
        select: {
          username: true,
          email: true,
          nickname: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw this.createRegistrationConflictException(error.meta?.target);
      }
      throw error;
    }
  }

  private createRegistrationConflictException(target: unknown) {
    const fields = Array.isArray(target)
      ? target.map(String)
      : typeof target === "string"
        ? [target]
        : [];

    if (fields.some((field) => field.includes("email"))) {
      return new BusinessException(
        BusinessErrorCode.USER_EMAIL_REGISTERED,
        "该邮箱已注册，请直接登录",
        HttpStatus.CONFLICT,
      );
    }
    if (fields.some((field) => field.includes("username"))) {
      return new BusinessException(
        BusinessErrorCode.USERNAME_REGISTERED,
        "该用户名已注册，请更换用户名",
        HttpStatus.CONFLICT,
      );
    }
    return new BusinessException(
      BusinessErrorCode.USER_REGISTRATION_CONFLICT,
      "注册信息已被占用，请更换后重试",
      HttpStatus.CONFLICT,
    );
  }

  async assertRegistrationAvailable(email: string, username?: string) {
    const existingUser = await this.prisma.chatUser.findFirst({
      where: {
        OR: [
          { email: { equals: email, mode: "insensitive" } },
          ...(username
            ? [{ username: { equals: username, mode: "insensitive" as const } }]
            : []),
        ],
      },
      select: { email: true, username: true },
    });
    if (!existingUser) return;

    if (existingUser.email.toLowerCase() === email.toLowerCase()) {
      throw new BusinessException(
        BusinessErrorCode.USER_EMAIL_REGISTERED,
        "该邮箱已注册，请直接登录",
        HttpStatus.CONFLICT,
      );
    }
    throw new BusinessException(
      BusinessErrorCode.USERNAME_REGISTERED,
      "该用户名已注册，请更换用户名",
      HttpStatus.CONFLICT,
    );
  }

  async findById(id: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findUnique({
      where: { id },
    });
  }

  /**
   * 获取用户的公开资料（剥离 passwordHash 等敏感字段），供「好友资料」等对外接口使用。
   * 注意：鉴权链路（auth.service.validatePayload / validateUserSession）仍依赖 findById
   * 取完整 ChatUser（需要 status / passwordHash 等），故不能复用本方法。
   */
  async findPublicProfile(id: string): Promise<Partial<ChatUser> | null> {
    return this.prisma.chatUser.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        nickname: true,
        email: true,
        avatarUrl: true,
        bio: true,
        lastLoginAt: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findByEmail(email: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
      },
    });
  }

  async findByUsername(username: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findFirst({
      where: {
        username: {
          equals: username,
          mode: "insensitive",
        },
      },
    });
  }

  async update(id: string, userData: Partial<ChatUser>): Promise<ChatUser> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({
      where: { id },
    });
    if (!existingUser) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    return this.prisma.chatUser.update({
      where: { id },
      data: userData,
    });
  }

  async delete(id: string): Promise<void> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({
      where: { id },
    });
    if (!existingUser) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.chatUser.delete({
      where: { id },
    });
  }

  async findAll(): Promise<ChatUser[]> {
    return this.prisma.chatUser.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async updateLastLogin(id: string): Promise<void> {
    const now = new Date();
    await this.prisma.chatUser.update({
      where: { id },
      data: {
        lastLoginAt: now,
        lastSeenAt: now,
      },
    });
  }

  async updateLastSeen(id: string, lastSeenAt = new Date()): Promise<void> {
    await this.prisma.chatUser.update({
      where: { id },
      data: { lastSeenAt },
    });
  }

  /**
   * 精确搜索用户 - 按用户名或邮箱精确匹配，排除自己和已有好友
   */
  async searchUsers(
    query: string,
    currentUserId?: string,
  ): Promise<ChatUser | null> {
    const user = await this.prisma.chatUser.findFirst({
      where: {
        id: currentUserId ? { not: currentUserId } : undefined,
        OR: [
          {
            username: {
              equals: query,
              mode: "insensitive",
            },
          },
          {
            email: {
              equals: query,
              mode: "insensitive",
            },
          },
        ],
      },
    });

    if (!user || !currentUserId) {
      return user;
    }

    const [senderId, receiverId] = this.getFriendshipPair(
      currentUserId,
      user.id,
    );
    const existingFriendship = await this.prisma.chatFriendship.findUnique({
      where: {
        senderId_receiverId: {
          senderId,
          receiverId,
        },
      },
    });

    return existingFriendship ? null : user;
  }

  /**
   * 模糊搜索用户 - 按用户名或邮箱或昵称模糊匹配
   */
  async searchUsersFuzzy(query: string): Promise<ChatUser[]> {
    return this.prisma.chatUser.findMany({
      where: {
        OR: [
          {
            username: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            email: {
              contains: query,
              mode: "insensitive",
            },
          },
          {
            nickname: {
              contains: query,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  async changeStatus(id: string, status: UserStatus): Promise<ChatUser> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({
      where: { id },
    });
    if (!existingUser) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    return this.prisma.chatUser.update({
      where: { id },
      data: { status: status as any },
    });
  }

  async login(loginDto: LoginDto): Promise<ChatUser | null> {
    // 检查用户是否存在（通过邮箱或用户名，大小写不敏感）
    const existingUser = await this.prisma.chatUser.findFirst({
      where: {
        OR: [
          {
            email: {
              equals: loginDto.account,
              mode: "insensitive",
            },
          },
          {
            username: {
              equals: loginDto.account,
              mode: "insensitive",
            },
          },
        ],
      },
    });

    if (!existingUser) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    // 检查密码是否匹配
    const passwordMatch = await bcrypt.compare(
      loginDto.password,
      existingUser.passwordHash,
    );
    if (!passwordMatch) {
      throw new BusinessException(
        BusinessErrorCode.USER_PASSWORD_INCORRECT,
        "密码错误",
        HttpStatus.UNAUTHORIZED,
      );
    }

    return existingUser;
  }

  async addFriend(senderId: string, addFriendDto: AddFriendDto) {
    const receiverId = addFriendDto.receiverId;
    if (senderId === receiverId) {
      throw new BusinessException(
        BusinessErrorCode.USER_CANNOT_ADD_SELF,
        "不能添加自己为好友",
        HttpStatus.BAD_REQUEST,
      );
    }

    const receiver = await this.prisma.chatUser.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });
    if (!receiver) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    const [userAId, userBId] = this.getFriendshipPair(senderId, receiverId);
    const existingFriendship = await this.prisma.chatFriendship.findUnique({
      where: {
        senderId_receiverId: {
          senderId: userAId,
          receiverId: userBId,
        },
      },
    });
    if (existingFriendship) {
      throw new BusinessException(
        BusinessErrorCode.USER_ALREADY_FRIENDS,
        "你们已经是好友了",
        HttpStatus.CONFLICT,
      );
    }

    const existingPendingRequest = await this.prisma.notification.findFirst({
      where: {
        type: "FRIEND_REQUEST",
        result: "PENDING",
        OR: [
          {
            senderId,
            receiverId,
          },
          {
            senderId: receiverId,
            receiverId: senderId,
          },
        ],
      },
    });
    if (existingPendingRequest) {
      throw new BusinessException(
        BusinessErrorCode.FRIEND_REQUEST_PENDING,
        "已有待处理的好友申请",
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.notification.create({
      data: {
        type: "FRIEND_REQUEST",
        senderId,
        receiverId,
        targetId: receiverId,
        extra: addFriendDto.message
          ? { message: addFriendDto.message }
          : undefined,
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            nickname: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  async getFriends(userId: string) {
    const friendships = await this.prisma.chatFriendship.findMany({
      where: {
        OR: [{ receiverId: userId }, { senderId: userId }],
      },
      include: {
        receiver: {
          select: {
            id: true,
            username: true,
            email: true,
            nickname: true,
            avatarUrl: true,
            bio: true,
            lastLoginAt: true,
            lastSeenAt: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        sender: {
          select: {
            id: true,
            username: true,
            email: true,
            nickname: true,
            avatarUrl: true,
            bio: true,
            lastLoginAt: true,
            lastSeenAt: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    this.logger.debug({
      event: "user.friendships.loaded",
      userId,
      count: friendships.length,
    });
    return friendships.map((friendship) => {
      return friendship.receiverId === userId
        ? friendship.sender
        : friendship.receiver;
    });
  }

  /**
   * 删除好友：移除好友关系，并软移除（INACTIVE）当前用户在该私聊的成员关系，
   * 让该私聊从会话列表消失。重新加好友时 getOrCreatePrivateRoom 会恢复成员状态。
   */
  async removeFriend(userId: string, friendId: string) {
    if (userId === friendId) {
      throw new BusinessException(
        BusinessErrorCode.USER_CANNOT_DELETE_SELF,
        "不能删除自己为好友",
        HttpStatus.BAD_REQUEST,
      );
    }

    const friend = await this.prisma.chatUser.findUnique({
      where: { id: friendId },
      select: { id: true },
    });
    if (!friend) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.NOT_FOUND,
      );
    }

    const [userAId, userBId] = this.getFriendshipPair(userId, friendId);

    // 1) 删除好友关系（记录可能已不存在，忽略 P2025）
    try {
      await this.prisma.chatFriendship.delete({
        where: {
          senderId_receiverId: {
            senderId: userAId,
            receiverId: userBId,
          },
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2025") throw e;
    }

    // 2) 级联：软移除当前用户在该私聊的成员关系，使其从会话列表消失。
    //    私聊房间名需与 ChatService.getPrivateRoomName 保持一致（排序后以 ':' 拼接）。
    const privateRoomName = [userAId, userBId].sort().join(":");
    const privateRoom = await this.prisma.chatRoom.findFirst({
      where: { topic: "PRIVATE", name: privateRoomName },
      select: { id: true },
    });
    if (privateRoom) {
      try {
        await this.prisma.roomMember.update({
          where: {
            roomId_userId: {
              roomId: privateRoom.id,
              userId,
            },
          },
          data: { status: "INACTIVE" },
        });
      } catch (e) {
        // 成员记录可能不存在（从未聊过天），忽略
        if ((e as { code?: string })?.code !== "P2025") throw e;
      }
    }
  }

  /**
   * 获取当前用户加入的群聊列表。
   * - 只取 status=ACTIVE 的成员关系；
   * - 排除私聊房间（topic='PRIVATE'），私聊由会话列表覆盖；
   * - 每个群附带当前用户的角色与群成员数，按房间 updatedAt 倒序。
   */
  async getGroups(userId: string) {
    const memberships = await this.prisma.roomMember.findMany({
      where: {
        userId,
        status: "ACTIVE",
        room: { topic: { not: "PRIVATE" } },
      },
      include: {
        room: {
          include: {
            _count: {
              select: { members: { where: { status: "ACTIVE" } } },
            },
          },
        },
      },
      orderBy: { room: { updatedAt: "desc" } },
    });

    return memberships.map((membership) => ({
      id: membership.room.id,
      name: membership.room.name,
      description: membership.room.description,
      topic: membership.room.topic,
      ownerId: membership.room.ownerId,
      isArchived: membership.room.isArchived,
      createdAt: membership.room.createdAt,
      updatedAt: membership.room.updatedAt,
      role: membership.role,
      joinedAt: membership.joinedAt,
      memberCount: membership.room._count.members,
    }));
  }
}
