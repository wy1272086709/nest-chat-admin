import { Injectable, ConflictException, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../common/database/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import { ChatUser, UserStatus } from '@prisma/client';
import { AddFriendDto, LoginDto } from '../dto/user.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  private getFriendshipPair(userId: string, friendId: string) {
    return [userId, friendId].sort() as [string, string];
  }

  async create(userData: Partial<ChatUser> & { password: string }): Promise<Pick<ChatUser, 'username' | 'email' | 'nickname'>> {
    // 检查邮箱是否已存在（大小写不敏感）
    const existingUser = await this.prisma.chatUser.findFirst({
      where: {
        email: {
          equals: userData.email!,
          mode: 'insensitive'
        }
      }
    });
    if (existingUser) {
      throw new HttpException('邮箱已存在！', HttpStatus.BAD_REQUEST);
    }

    // 检查用户名是否已存在（大小写不敏感）
    const existingUsername = await this.prisma.chatUser.findFirst({
      where: {
        username: {
          equals: userData.username!,
          mode: 'insensitive'
        }
      }
    });
    if (existingUsername) {
      throw new HttpException('用户名已存在！', HttpStatus.BAD_REQUEST);
    }

    const passwordHash = await bcrypt.hash(userData.password, 10);

    const result = await this.prisma.chatUser.create({
      data: {
        username: userData.username!,
        email: userData.email!,
        nickname: userData.nickname!,
        passwordHash,
        status: 'ACTIVE',
      },
      select: {
        username: true,
        email: true,
        nickname: true,
      },
    });
    return result;
  }

  async findById(id: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findUnique({
      where: { id },
    });
  }

  async findByEmail(email: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      },
    });
  }

  async findByUsername(username: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findFirst({
      where: {
        username: {
          equals: username,
          mode: 'insensitive'
        }
      },
    });
  }

  async update(id: string, userData: Partial<ChatUser>): Promise<ChatUser> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({ where: { id } });
    if (!existingUser) {
      throw new NotFoundException('ChatUser not found');
    }

    return this.prisma.chatUser.update({
      where: { id },
      data: userData,
    });
  }

  async delete(id: string): Promise<void> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({ where: { id } });
    if (!existingUser) {
      throw new NotFoundException('ChatUser not found');
    }

    await this.prisma.chatUser.delete({
      where: { id }
    });
  }

  async findAll(): Promise<ChatUser[]> {
    return this.prisma.chatUser.findMany({
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.chatUser.update({
      where: { id },
      data: {
        lastLoginAt: new Date()
      }
    });
  }

  /**
   * 精确搜索用户 - 按用户名或邮箱精确匹配，排除自己和已有好友
   */
  async searchUsers(query: string, currentUserId?: string): Promise<ChatUser | null> {
    const user = await this.prisma.chatUser.findFirst({
      where: {
        id: currentUserId ? { not: currentUserId } : undefined,
        OR: [
          {
            username: {
              equals: query,
              mode: 'insensitive'
            }
          },
          {
            email: {
              equals: query,
              mode: 'insensitive'
            }
          }
        ]
      },
    });

    if (!user || !currentUserId) {
      return user;
    }

    const [senderId, receiverId] = this.getFriendshipPair(currentUserId, user.id);
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
              mode: 'insensitive'
            }
          },
          {
            email: {
              contains: query,
              mode: 'insensitive'
            }
          },
          {
            nickname: {
              contains: query,
              mode: 'insensitive'
            }
          }
        ]
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async changeStatus(id: string, status: UserStatus): Promise<ChatUser> {
    // 检查用户是否存在
    const existingUser = await this.prisma.chatUser.findUnique({ where: { id } });
    if (!existingUser) {
      throw new NotFoundException('ChatUser not found');
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
              mode: 'insensitive'
            }
          },
          {
            username: {
              equals: loginDto.account,
              mode: 'insensitive'
            }
          }
        ]
      }
    });

    if (!existingUser) {
      throw new NotFoundException('用户不存在');
    }

    // 检查密码是否匹配
    const passwordMatch = await bcrypt.compare(loginDto.password, existingUser.passwordHash);
    if (!passwordMatch) {
      throw new NotFoundException('密码错误');
    }

    return existingUser;
  }

  async addFriend(senderId: string, addFriendDto: AddFriendDto) {
    const receiverId = addFriendDto.receiverId;
    if (senderId === receiverId) {
      throw new HttpException('不能添加自己为好友', HttpStatus.BAD_REQUEST);
    }

    const receiver = await this.prisma.chatUser.findUnique({
      where: { id: receiverId },
      select: { id: true },
    });
    if (!receiver) {
      throw new NotFoundException('用户不存在');
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
      throw new ConflictException('你们已经是好友了');
    }

    const existingPendingRequest = await this.prisma.notification.findFirst({
      where: {
        type: 'FRIEND_REQUEST',
        result: 'PENDING',
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
      throw new ConflictException('已有待处理的好友申请');
    }

    return this.prisma.notification.create({
      data: {
        type: 'FRIEND_REQUEST',
        senderId,
        receiverId,
        targetId: receiverId,
        extra: addFriendDto.message ? { message: addFriendDto.message } : undefined,
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
        OR: [
          { receiverId: userId },
          { senderId: userId },
        ],
      },
      include: {
        receiver: true,
        sender: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    console.log('friendships', friendships);
    return friendships.map((friendship) => {
      const friend = friendship.receiverId === userId ? friendship.sender : friendship.receiver;
      const { passwordHash, ...safeFriend } = friend;
      return safeFriend;
    });
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
        status: 'ACTIVE',
        room: { topic: { not: 'PRIVATE' } },
      },
      include: {
        room: {
          include: {
            _count: {
              select: { members: { where: { status: 'ACTIVE' } } },
            },
          },
        },
      },
      orderBy: { room: { updatedAt: 'desc' } },
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
