import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import * as bcrypt from 'bcryptjs';
import { ChatUser } from '@prisma/client';
import { UserStatus } from 'prisma/enum';
import { LoginDto } from '../dto/user.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userData: Partial<ChatUser> & { password: string }): Promise<Pick<ChatUser, 'username' | 'email' | 'nickname'>> {
    // 检查邮箱是否已存在
    const existingUser = await this.prisma.chatUser.findUnique({
      where: { email: userData.email! }
    });
    if (existingUser) {
      throw new ConflictException('邮箱已存在！');
    }

    // 检查用户名是否已存在
    const existingUsername = await this.prisma.chatUser.findUnique({
      where: { username: userData.username! }
    });
    if (existingUsername) {
      throw new ConflictException('用户名已存在！');
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
    return this.prisma.chatUser.findUnique({
      where: { email },
    });
  }

  async findByUsername(username: string): Promise<ChatUser | null> {
    return this.prisma.chatUser.findUnique({
      where: { username },
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

  async searchUsers(query: string): Promise<ChatUser[]> {
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
          }
        ]
      },
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
    // 检查用户是否存在（通过邮箱或用户名）
    const existingUser = await this.prisma.chatUser.findFirst({
      where: {
        OR: [
          { email: loginDto.account },
          { username: loginDto.account }
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
}