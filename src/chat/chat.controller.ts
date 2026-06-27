import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatUser } from '@prisma/client';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { CreateGroupRoomDto, HistoryQueryDto, InitPrivateRoomDto } from './dto/chat.dto';

/**
 * 聊天 HTTP 接口。
 * 与 ChatGateway（WebSocket）分工：
 * - Gateway：消息收发、实时推送（在线即时同步）
 * - Controller：会话列表、历史消息、成员、已读、清空等「请求-响应」型操作，
 *   以及通过 HTTP 建群 / 发起私聊（同样会调用 gateway 推送，保证实时同步）。
 * 两者共用同一个 ChatService，不重复业务逻辑。
 */
@ApiTags('Chat')
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Post('rooms/group')
  @ApiOperation({ description: '创建群聊房间（同时实时通知所有成员）' })
  async createGroupRoom(@CurrentUser() user: ChatUser, @Body() dto: CreateGroupRoomDto) {
    try {
      const room = await this.chatService.createGroupRoom(user.id, dto);
      // 实时同步给所有群成员
      this.chatGateway.emitToUsers(
        room.members.map((member) => member.userId),
        'room:created',
        room,
      );
      return { message: '群聊创建成功', result: true, data: room };
    } catch (error) {
      console.log(error);
      return { message: error.message || '群聊创建失败', result: false, data: null };
    }
  }

  @Post('rooms/private')
  @ApiOperation({ description: '发起或获取与指定用户的私聊会话（同时实时通知双方）' })
  async createPrivateRoom(@CurrentUser() user: ChatUser, @Body() dto: InitPrivateRoomDto) {
    try {
      const room = await this.chatService.getOrCreatePrivateRoom(user.id, dto.receiverId);
      this.chatGateway.emitToUsers(
        room.members.map((member) => member.userId),
        'room:private',
        room,
      );
      return { message: '私聊会话获取成功', result: true, data: room };
    } catch (error) {
      console.log(error);
      return { message: error.message || '私聊会话获取失败', result: false, data: null };
    }
  }

  @Get('rooms')
  @ApiOperation({ description: '获取当前用户的会话列表（群聊+私聊，含最后一条消息与未读数）' })
  async listConversations(@CurrentUser() user: ChatUser) {
    try {
      const data = await this.chatService.listConversations(user.id);
      return { message: '会话列表获取成功', result: true, data };
    } catch (error) {
      console.log(error);
      return { message: error.message || '会话列表获取失败', result: false, data: null };
    }
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({ description: '分页获取某个聊天室的历史消息（自动过滤已清空的消息）' })
  async getMessages(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Query() query: HistoryQueryDto,
  ) {
    try {
      const data = await this.chatService.getMessages(user.id, { roomId, take: query.take });
      return { message: '历史消息获取成功', result: true, data };
    } catch (error) {
      console.log(error);
      return { message: error.message || '历史消息获取失败', result: false, data: null };
    }
  }

  @Get('rooms/:roomId/members')
  @ApiOperation({ description: '获取某个聊天室的成员列表' })
  async getRoomMembers(@CurrentUser() user: ChatUser, @Param('roomId') roomId: string) {
    try {
      const data = await this.chatService.getRoomMembers(roomId, user.id);
      return { message: '成员列表获取成功', result: true, data };
    } catch (error) {
      console.log(error);
      return { message: error.message || '成员列表获取失败', result: false, data: null };
    }
  }

  @Post('rooms/:roomId/read')
  @ApiOperation({ description: '将某个聊天室标记为已读（同时实时同步给房间内成员）' })
  async markRead(@CurrentUser() user: ChatUser, @Param('roomId') roomId: string) {
    try {
      const result = await this.chatService.markRoomRead(user.id, roomId);
      this.chatGateway.emitToRoom(roomId, 'room:read', {
        roomId,
        userId: user.id,
        lastReadAt: result.lastReadAt,
      });
      return { message: '已读设置成功', result: true, data: result };
    } catch (error) {
      console.log(error);
      return { message: error.message || '已读设置失败', result: false, data: null };
    }
  }

  @Post('rooms/:roomId/clear')
  @ApiOperation({ description: '清空当前用户在该聊天室的聊天记录（仅对当前用户隐藏，不删除原消息）' })
  async clearRoom(@CurrentUser() user: ChatUser, @Param('roomId') roomId: string) {
    try {
      const result = await this.chatService.clearRoom(user.id, roomId);
      return { message: '聊天记录已清空', result: true, data: result };
    } catch (error) {
      console.log(error);
      return { message: error.message || '聊天记录清空失败', result: false, data: null };
    }
  }
}
