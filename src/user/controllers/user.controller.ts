import { Controller, Get, Post, Body, Param, Put, Delete, Query } from '@nestjs/common';
import { UserService } from '../services/user.service';
import { ChatUser } from '@prisma/client';
import { CreateUserDto, ForgetPasswordDto, LoginDto, SendEmailDto, EmailVerificationType } from '../dto/user.dto';
import { EmailService } from '@/common/core/services/email.service';
import { RedisService } from '@/common/core/services/redis.service';
import { AuthService } from '@/common/auth/services/auth.service';
import { Public } from '@/common/auth/decorators/public.decorator';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
import { DataResult } from '@/common/core/interceptors/transform.interceptor';
import { ApiOperation } from '@nestjs/swagger';

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
        return {
          message: '验证码错误',
          data: null,
          result: false,
        };
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

  // 发送验证码到邮箱邮箱, type 为 register 或 forgetPassword
  @Post('sendEmail')
  @Public() // 标记为公开路由，不需要JWT认证
  @ApiOperation({ description: '发送验证码到邮箱邮箱' })
  async sendEmailTo(@Body() sendEmailDto: SendEmailDto) {
    const { to, type } = sendEmailDto;
    try {
      // 生成验证码
      const code = this.emailService.generateVerificationCode();
      const key = `verificationCode:${to}:${type}:limit`;
      if (await this.redisService.get(key)) {
        return {
          data: null,
          message: '请稍后重试，避免频繁发送',
          result: false,
        }
      }
      const codeKey = `verificationCode:${to}:${type}`;
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

  @Post('forgetPassword')
  @Public() // 标记为公开路由，不需要JWT认证
  @ApiOperation({ description: '忘记密码，重置密码' })
  async forgetPassword(@Body() forgetPasswordDto: ForgetPasswordDto) {
    try {
      const { username, email, code, password } = forgetPasswordDto;

      // 1. 判断用户或者邮箱是否存在
      const user = await this.userService.findByUsername(username);
      if (!user) {
        return {
          message: '用户不存在',
          data: null,
          result: false,
        };
      }

      // 校验邮箱是否匹配
      if (user.email !== email) {
        return {
          message: '邮箱与用户不匹配',
          data: null,
          result: false,
        };
      }

      // 2. 校验验证码是否正确
      const codeKey = `verificationCode:${email}:${EmailVerificationType.FORGET_PASSWORD}`;
      const storedCode = await this.redisService.get(codeKey);

      if (!storedCode) {
        return {
          message: '验证码已过期或不存在',
          data: null,
          result: false,
        };
      }

      if (code !== storedCode) {
        return {
          message: '验证码错误',
          data: null,
          result: false,
        };
      }

      // 3. 更新密码
      const passwordHash = await import('bcryptjs').then(bcrypt => bcrypt.hash(password, 10));
      await this.userService.update(user.id, { passwordHash });

      // 清除已使用的验证码
      await this.redisService.del(codeKey);

      // 4. 更新密码成功后，返回成功信息
      return {
        message: '密码重置成功',
        data: {
          username: user.username,
          email: user.email,
        },
        result: true,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '密码重置失败',
        data: null,
        result: false,
      };
    }
  }

  @Post('login')
  @Public() // 标记为公开路由，不需要JWT认证
  async login(@Body() loginDto: LoginDto) {
    try {
      // 检查验证码是否正确
      // 从 Redis 获取存储的验证码
      let message = ''; 
      let data = null;

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


  @Post('logout')
  async logout(@CurrentUser() user: ChatUser) {
    // 清除用户 token
    await this.authService.logout(user);
    return {
      message: '退出成功',
      result: true,
      data: null,
    };
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
