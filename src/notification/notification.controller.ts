import { Body, Controller, Get, Post } from '@nestjs/common';
import { ChatUser } from '@prisma/client';
import { ApiOperation } from '@nestjs/swagger';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
import { ChatGateway } from '@/chat/chat.gateway';
import { HandleFriendRequestDto, MarkNotificationReadDto } from './dto/notification.dto';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get()
  @ApiOperation({ description: '获取当前用户收到的所有通知，包括好友申请、群聊邀请等' })
  async findReceived(@CurrentUser() user: ChatUser) {
    try {
      const result = await this.notificationService.findReceived(user.id);
      return {
        message: '通知列表获取成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '通知列表获取失败',
        result: false,
        data: null,
      };
    }
  }

  @Get('friendRequests')
  @ApiOperation({ description: '获取当前用户收到的好友申请通知' })
  async findFriendRequests(@CurrentUser() user: ChatUser) {
    try {
      const result = await this.notificationService.findFriendRequests(user.id);
      return {
        message: '好友申请获取成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '好友申请获取失败',
        result: false,
        data: null,
      };
    }
  }

  @Post('markRead')
  async markRead(@CurrentUser() user: ChatUser, @Body() markDto: MarkNotificationReadDto) {
    try {
      const result = await this.notificationService.markRead(user.id, markDto.notificationId);
      this.chatGateway.emitToUser(user.id, 'notification:updated', { notification: result });
      this.chatGateway.emitToUser(user.id, 'notification:read', {
        notificationId: result.id,
        userId: user.id,
      });
      return {
        message: '通知已读成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '通知已读失败',
        result: false,
        data: null,
      };
    }
  }

  @Post('markAllRead')
  async markAllRead(@CurrentUser() user: ChatUser) {
    try {
      const result = await this.notificationService.markAllRead(user.id);
      this.chatGateway.emitToUser(user.id, 'notification:readAll', { userId: user.id });
      return {
        message: '通知全部已读成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '通知全部已读失败',
        result: false,
        data: null,
      };
    }
  }

  @Post('handleFriendRequest')
  async handleFriendRequest(@CurrentUser() user: ChatUser, @Body() handleDto: HandleFriendRequestDto) {
    try {
      const result = await this.notificationService.handleFriendRequest(user.id, handleDto);
      this.chatGateway.emitToUsers([result.senderId, result.receiverId], 'friend:requestHandled', {
        notificationId: result.id,
        result: result.result,
        senderId: result.senderId,
        receiverId: result.receiverId,
      });
      this.chatGateway.emitToUser(result.receiverId, 'notification:updated', { notification: result });
      return {
        message: '好友申请处理成功',
        result: true,
        data: result,
      };
    } catch (error) {
      console.log(error);
      return {
        message: error.message || '好友申请处理失败',
        result: false,
        data: null,
      };
    }
  }
}
