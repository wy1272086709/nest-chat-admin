import { Injectable, Inject, forwardRef, HttpStatus } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "../../../user/services/user.service";
import { ChatUser } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { RedisService } from "@/common/core/services/redis.service";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";

type JwtPayload = {
  sub: string;
  email: string;
  username: string;
  jti?: string;
  exp?: number;
};

type TokenResult = {
  access_token: string;
  token_type: "Bearer";
  expires_at: string;
  expires_in: number;
};

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private config: ConfigService,
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => UserService))
    private userService: UserService,
  ) {}

  private getCurrentJtiKey(userId: string) {
    return `auth:current-jti:${userId}`;
  }

  /**
   * 验证用户凭据（用于Local Strategy）
   * @param account 用户账号（邮箱或用户名）
   * @param password 用户密码
   * @returns 验证成功返回用户信息，失败返回null
   */
  async validateUser(
    account: string,
    password: string,
  ): Promise<ChatUser | null> {
    // 先尝试通过邮箱查找用户
    const user = await this.userService.findByEmail(account);

    // 如果邮箱查找失败，尝试通过用户名查找
    if (!user) {
      const userByUsername = await this.userService.findByUsername(account);
      if (!userByUsername) {
        return null;
      }

      // 验证密码
      const passwordMatch = await bcrypt.compare(
        password,
        userByUsername.passwordHash,
      );
      if (!passwordMatch) {
        return null;
      }
      this.assertUserActive(userByUsername);
      return userByUsername;
    }

    // 验证密码
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return null;
    }
    this.assertUserActive(user);
    return user;
  }

  /**
   * 生成JWT token
   * @param user 用户信息
   * @returns 包含access_token和用户信息的对象
   */
  async login(
    user: ChatUser,
  ): Promise<{ access_token: string; user: Omit<ChatUser, "passwordHash"> }> {
    this.assertUserActive(user);
    const jti = randomUUID();
    const tokenResult = await this.issueAccessToken(user, jti);

    // 返回token和用户信息（不包含密码）
    const { passwordHash, ...userWithoutPassword } = user;
    return {
      access_token: tokenResult.access_token,
      user: userWithoutPassword,
    };
  }

  async refreshAccessToken(
    user: Pick<ChatUser, "id" | "email" | "username" | "status">,
    jti: string,
  ): Promise<TokenResult> {
    this.assertUserActive(user);
    await this.assertSessionIsCurrent(user.id, jti);
    return this.issueAccessToken(user, jti);
  }

  async validatePayload(payload: JwtPayload): Promise<ChatUser> {
    const user = await this.userService.findById(payload.sub);
    if (!user) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.assertUserActive(user);
    await this.assertSessionIsCurrent(user.id, payload.jti);
    return user;
  }

  async validateUserSession(userId: string, jti?: string): Promise<ChatUser> {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new BusinessException(
        BusinessErrorCode.USER_NOT_FOUND,
        "用户不存在",
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.assertUserActive(user);
    await this.assertSessionIsCurrent(user.id, jti);
    return user;
  }

  async assertSessionIsCurrent(userId: string, jti?: string) {
    if (!jti) {
      throw new BusinessException(
        BusinessErrorCode.AUTH_SESSION_EXPIRED,
        "登录会话已失效，请重新登录",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const currentJti = await this.redisService.get(
      this.getCurrentJtiKey(userId),
    );
    if (currentJti !== jti) {
      throw new BusinessException(
        BusinessErrorCode.AUTH_SESSION_EXPIRED,
        "账号已在其他设备登录",
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  assertUserActive(user: Pick<ChatUser, "status">) {
    if (user.status !== "ACTIVE") {
      throw new BusinessException(
        BusinessErrorCode.AUTH_ACCOUNT_DISABLED,
        "账号已被禁用",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async issueAccessToken(
    user: Pick<ChatUser, "id" | "email" | "username">,
    jti: string,
  ): Promise<TokenResult> {
    const accessToken = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        username: user.username,
        jti,
      },
      {
        expiresIn: this.config.get("jwt.expiresIn"),
      },
    );

    const decoded = this.jwtService.decode(accessToken) as JwtPayload | null;
    const expiresAtMs = decoded?.exp ? decoded.exp * 1000 : Date.now();
    const expiresIn = Math.max(
      Math.floor((expiresAtMs - Date.now()) / 1000),
      1,
    );
    await this.redisService.set(this.getCurrentJtiKey(user.id), jti, expiresIn);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_at: new Date(expiresAtMs).toISOString(),
      expires_in: expiresIn,
    };
  }

  /**
   * 验证JWT token
   * @param token JWT token字符串
   * @returns 解析后的payload
   */
  async verifyToken(token: string): Promise<JwtPayload> {
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
  async logout(user: ChatUser & { tokenJti?: string }): Promise<void> {
    if (!user.tokenJti) {
      await this.redisService.del(this.getCurrentJtiKey(user.id));
      return;
    }

    const currentJti = await this.redisService.get(
      this.getCurrentJtiKey(user.id),
    );
    if (currentJti === user.tokenJti) {
      await this.redisService.del(this.getCurrentJtiKey(user.id));
    }
  }
}
