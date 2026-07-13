import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  Query,
  Request,
} from '@nestjs/common';
import { UserService } from '../services/user.service';
import { ChatUser } from '@prisma/client';
import {
  AddFriendDto,
  CreateUserDto,
  ForgetPasswordDto,
  LoginDto,
  SendEmailDto,
  EmailVerificationType,
  UpdateUserDto,
  SearchDto,
  ChangeUserStatusDto,
  RemoveFriendDto,
} from '../dto/user.dto';
import { EmailService } from '@/common/core/services/email.service';
import { RedisService } from '@/common/core/services/redis.service';
import { MailQueueService } from '@/common/core/services/mail-queue.service';
import { AuthService } from '@/common/auth/services/auth.service';
import { Public } from '@/common/auth/decorators/public.decorator';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
import { DataResult } from '@/common/core/interceptors/transform.interceptor';
import { ApiOperation } from '@nestjs/swagger';
import { ChatGateway } from '@/chat/chat.gateway';
import * as bcrypt from 'bcryptjs';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly emailService: EmailService,
    private readonly redisService: RedisService,
    private readonly mailQueueService: MailQueueService,
    private readonly authService: AuthService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get()
  async findAll(): Promise<ChatUser[]> {
    return this.userService.findAll();
  }

  // 注意：静态路由（friends/groups 等）必须声明在 @Get(':id') 之前。
  // NestJS 按声明顺序注册路由，Express 会匹配第一个注册的路由，
  // 若 ':id' 在前，GET /users/friends 会被它捕获（id='friends'），永远到不了 getFriends。

  @Post('register')
  @Public() // 标记为公开路由，不需要JWT认证
  async register(
    @Body() createUserDto: CreateUserDto,
  ): Promise<DataResult<Partial<ChatUser>>> {
    try {
      // 校验验证码是否正确
      const codeKey = `verificationCode:${createUserDto.email}:${EmailVerificationType.REGISTER}`;
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
    } catch (e) {
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
        };
      }
      const codeKey = `verificationCode:${to}:${type}`;
      // Redis 存储验证码，过期时间为 10 分钟
      // 这里可以使用 Redis 客户端，例如 ioredis 或 redis
      const ttlSeconds = 10 * 60;
      await this.redisService.set(codeKey, code, ttlSeconds);
      // 设置限流间隔为 1 分钟
      await this.redisService.set(key, 1, 60);

      try {
        await this.mailQueueService.publishVerificationCode({
          email: to,
          type,
          code,
          codeKey,
          ttlSeconds,
        });
      } catch (error) {
        await Promise.all([
          this.redisService.del(codeKey),
          this.redisService.del(key),
        ]);
        throw error;
      }

      return {
        message: '验证码已发送，请查收邮箱',
        result: true,
        data: null,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '验证码发送失败',
        result: false,
        data: null,
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
      const passwordHash = await bcrypt.hash(password, 10);
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
      const user = await this.authService.validateUser(
        loginDto.account,
        loginDto.password,
      );
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

      this.chatGateway.disconnectUser(user.id);

      // 生成JWT token
      const loginResult = await this.authService.login(user);

      // 返回登陆成功后的token和用户信息
      return {
        message: '登录成功',
        result: true,
        data: loginResult, // 包含 access_token 和 user 信息
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

  @Post('saveProfile')
  async saveProfile(@Request() req, @Body() updateUserDto: UpdateUserDto) {
    try {
      // 更新用户信息
      const result = await this.userService.update(req.user.id, updateUserDto);
      return {
        message: '用户信息更新成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '用户信息更新失败',
        result: false,
        data: null,
      };
    }
  }

  @Post('searchFriend')
  async searchFriend(
    @CurrentUser() user: ChatUser,
    @Body() searchDto: SearchDto,
  ) {
    try {
      const result = await this.userService.searchUsers(
        searchDto.query,
        user.id,
      );
      return {
        message: '用户搜索成功',
        result: true,
        data: result ? [result] : [],
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '用户搜索失败',
        result: false,
        data: null,
      };
    }
  }

  @Post('searchUsers')
  @ApiOperation({ description: '模糊搜索用户' })
  async searchUsersFuzzy(@Body() searchDto: SearchDto) {
    try {
      const users = await this.userService.searchUsersFuzzy(searchDto.query);
      return {
        message: '用户模糊搜索成功',
        result: true,
        data: users,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '用户模糊搜索失败',
        result: false,
        data: null,
      };
    }
  }

  // 添加好友的方法
  @Post('addFriend')
  async addFriend(
    @CurrentUser() user: ChatUser,
    @Body() addFriendDto: AddFriendDto,
  ) {
    try {
      const notification = await this.userService.addFriend(
        user.id,
        addFriendDto,
      );
      this.chatGateway.emitToUser(notification.receiverId, 'notification:new', {
        notification,
      });
      this.chatGateway.emitToUser(notification.receiverId, 'friend:request', {
        notification,
      });
      return {
        message: '好友申请已发送',
        result: true,
        data: null,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '添加好友失败',
        result: false,
        data: null,
      };
    }
  }

  // 删除好友：移除好友关系并让该私聊从双方会话列表消失
  @Post('deleteFriend')
  async deleteFriend(
    @CurrentUser() user: ChatUser,
    @Body() removeFriendDto: RemoveFriendDto,
  ) {
    try {
      await this.userService.removeFriend(user.id, removeFriendDto.friendId);
      // 通知双方刷新会话/通讯录（前端 onAny 会捕获含 'friend' 的事件）
      this.chatGateway.emitToUsers(
        [user.id, removeFriendDto.friendId],
        'friend:removed',
        { userId: user.id, friendId: removeFriendDto.friendId },
      );
      return {
        message: '已删除好友',
        result: true,
        data: null,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '删除好友失败',
        result: false,
        data: null,
      };
    }
  }

  @Get('friends')
  async getFriends(@CurrentUser() user: ChatUser) {
    try {
      const result = await this.userService.getFriends(user.id);
      console.log('result', result);
      return {
        message: '好友列表获取成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '好友列表获取失败',
        result: false,
        data: null,
      };
    }
  }

  @Get('groups')
  @ApiOperation({
    description: '获取当前用户加入的群聊列表（含角色与成员数，排除私聊）',
  })
  async getGroups(@CurrentUser() user: ChatUser) {
    try {
      const result = await this.userService.getGroups(user.id);
      return {
        message: '群聊列表获取成功',
        result: true,
        data: Array.isArray(result) ? result : [],
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '群聊列表获取失败',
        result: false,
        data: null,
      };
    }
  }

  @Put(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() body: ChangeUserStatusDto,
  ) {
    try {
      const result = await this.userService.changeStatus(id, body.status);
      if (body.status !== 'ACTIVE') {
        this.chatGateway.disconnectUser(id, '账号已被禁用', 'auth:disabled');
      }

      return {
        message: '用户状态更新成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '用户状态更新失败',
        result: false,
        data: null,
      };
    }
  }

  // 动态参数路由放在最后，避免拦截 friends/groups 等静态路由。
  @Get(':id')
  async findById(@Param('id') id: string): Promise<Partial<ChatUser> | null> {
    // 用 findPublicProfile 剥离 passwordHash，供「好友资料」等对外展示使用
    return this.userService.findPublicProfile(id);
  }
}
