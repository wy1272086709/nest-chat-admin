import { Controller, Get, Post, Body, Param, Put, Delete, Query } from '@nestjs/common';
import { UserService } from '../services/user.service';
import { ChatUser } from '@prisma/client';
import { CreateUserDto, LoginDto } from '../dto/user.dto';
import { EmailService } from '@/common/services/email.service';
import { RedisService } from '@/common/services/redis.service';
import { AuthService } from '@/auth/services/auth.service';
import { Public } from '@/auth/decorators/public.decorator';
import { CurrentUser } from '@/auth/decorators/current-user.decorator';
import { DataResult } from '@/common/interceptors/transform.interceptor';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly emailService: EmailService,
    private readonly redisService: RedisService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async findAll(): Promise<ChatUser[]> {
    return this.userService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<ChatUser> {
    return this.userService.findById(id);
  }

  @Post('register')
  @Public() // 标记为公开路由，不需要JWT认证
  async register(@Body() createUserDto: CreateUserDto): Promise<DataResult<Partial<ChatUser>>> {
    try {
      // 校验验证码是否正确
      const codeKey = `verificationCode:${createUserDto.email}`;
      const codeVal = await this.redisService.get(codeKey);
      let message = '';
      let data: Partial<ChatUser> | null = null;
      if (createUserDto.code !== codeVal) {
        message = '验证码错误';
        data = null;
      }
      // 校验数据合法性
      const user = await this.userService.create(createUserDto);
      if (user) {
        message = '注册成功';
        data = user;
      }
      return {
        message,
        data,
        result: true,
      };
    } catch(e) {
      console.log(e);
      return {
        message: e.message || '注册失败',
        data: null,
        result: false,
      };
    }
  }

  @Post('sendEmail')
  @Public() // 标记为公开路由，不需要JWT认证
  async sendEmailTo(@Body('to') to: string) {
    try {
      // 生成验证码
      const code = this.emailService.generateVerificationCode();
      const key = `verificationCode:${to}:limit`;
      if (await this.redisService.get(key)) {
        return {
          data: null,
          message: '请稍后重试，避免频繁发送',
          result: false,
        }
      }
      const codeKey = `verificationCode:${to}`;
      // Redis 存储验证码，过期时间为 10 分钟
      // 这里可以使用 Redis 客户端，例如 ioredis 或 redis
      await this.redisService.set(codeKey, code, 10 * 60);
      // 设置限流间隔为 1 分钟
      await this.redisService.set(key, 1, 60);
      await this.emailService.sendVerificationCode(
        to,
        code,
      );
      return {
        message: '验证码发送成功',
        result: true,
        data: {
          code,
        }
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '验证码发送失败',
        result: false,
        data: null
      };
    }
  }

  @Post('login')
  @Public() // 标记为公开路由，不需要JWT认证
  async login(@Body() loginDto: LoginDto) {
    try {
      // 检查验证码是否正确
      // 从 Redis 获取存储的验证码
      const storedCode = await this.redisService.get(`verificationCode:${loginDto.account}`);
      let message = ''; 
      let data = null;
      if (!storedCode) {
        message = '验证码已过期或不存在';
      }

      // 验证码不区分大小写比较
      if (storedCode.toLowerCase() !== loginDto.verificationCode.toLowerCase()) {
        message = '验证码错误';
      }

      // 使用AuthService验证用户凭据
      const user = await this.authService.validateUser(loginDto.account, loginDto.password);
      if (!user) {
        message = '用户名或密码错误';
      }

      if (message && !data) {
        return {
          message,
          result: false,
          data: null,
        };
      }
      // 更新最后登录时间
      await this.userService.updateLastLogin(user.id);

      // 生成JWT token
      const loginResult = await this.authService.login(user);

      // 返回登陆成功后的token和用户信息
      return {
        message: '登录成功',
        result: true,
        data: loginResult // 包含 access_token 和 user 信息
      };
    } catch (error) {
      // 返回错误信息
      return {
        message: error.message || '登录失败',
        data: null,
        result: false,
      };
    } finally {
      // 清除已使用的验证码
      await this.redisService.del(`verificationCode:${loginDto.account}`);
    }
  }

  @Get('profile')
  async getProfile(@CurrentUser() user: ChatUser) {
    return {
      message: '获取用户信息成功',
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    };
  }
}