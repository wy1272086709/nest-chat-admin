import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../../../user/services/user.service';
import { ChatUser } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    @Inject(forwardRef(() => UserService))
    private userService: UserService,
  ) {}

  /**
   * 验证用户凭据（用于Local Strategy）
   * @param account 用户账号（邮箱或用户名）
   * @param password 用户密码
   * @returns 验证成功返回用户信息，失败返回null
   */
  async validateUser(account: string, password: string): Promise<ChatUser | null> {
    // 先尝试通过邮箱查找用户
    const user = await this.userService.findByEmail(account);

    // 如果邮箱查找失败，尝试通过用户名查找
    if (!user) {
      const userByUsername = await this.userService.findByUsername(account);
      if (!userByUsername) {
        return null;
      }

      // 验证密码
      const passwordMatch = await bcrypt.compare(password, userByUsername.passwordHash);
      return passwordMatch ? userByUsername : null;
    }

    // 验证密码
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    return passwordMatch ? user : null;
  }

  /**
   * 生成JWT token
   * @param user 用户信息
   * @returns 包含access_token和用户信息的对象
   */
  async login(user: ChatUser): Promise<{ access_token: string; user: Omit<ChatUser, 'passwordHash'> }> {
    const payload = {
      sub: user.id,
      email: user.email,
      username: user.username
    };
    // 设置 7 天过期时间
    const access_token = this.jwtService.sign(payload, { expiresIn: '7d' });

    // 返回token和用户信息（不包含密码）
    const { passwordHash, ...userWithoutPassword } = user;
    return {
      access_token,
      user: userWithoutPassword,
    };
  }

  /**
   * 验证JWT token
   * @param token JWT token字符串
   * @returns 解析后的payload
   */
  async verifyToken(token: string): Promise<any> {
    return this.jwtService.verify(token);
  }

  /**
   * 通过用户ID获取用户信息
   * @param userId 用户ID
   * @returns 用户信息
   */
  async getUserById(userId: string): Promise<ChatUser | null> {
    return this.userService.findById(userId);
  }

  /**
   * 退出登录
   * @param user 用户信息
   */
  async logout(user: ChatUser): Promise<void> {
    
  }
}