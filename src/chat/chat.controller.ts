import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatUser } from '@prisma/client';
import { CurrentUser } from '@/common/auth/decorators/current-user.decorator';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import {
  AddMembersDto,
  ChatAiReplySuggestionsDto,
  ChatAiSummaryDto,
  CreateGroupRoomDto,
  HistoryQueryDto,
  InitPrivateRoomDto,
  SyncMessagesQueryDto,
} from './dto/chat.dto';
import { SERVICE_ERROR_MESSAGE } from '@/common/core/constants/error-message.constant';
import { ChatAiService } from './chat-ai.service';

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
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
    private readonly chatAiService: ChatAiService,
  ) {}

  @Post('rooms/:roomId/ai/summary')
  @ApiOperation({
    description: '使用最近的聊天消息生成摘要、关键要点和待办事项',
  })
  async generateAiSummary(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Body() dto: ChatAiSummaryDto,
  ) {
    const data = await this.chatAiService.summarize(
      user.id,
      roomId,
      dto.messageLimit,
    );
    return { message: '聊天总结生成成功', result: true, data };
  }

  @Post('rooms/:roomId/ai/reply-suggestions')
  @ApiOperation({ description: '根据最近聊天消息和可选草稿生成回复建议' })
  async generateAiReplySuggestions(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Body() dto: ChatAiReplySuggestionsDto,
  ) {
    const data = await this.chatAiService.suggestReplies(
      user.id,
      roomId,
      dto.messageLimit,
      dto.draft,
    );
    return { message: '回复建议生成成功', result: true, data };
  }

  @Post('rooms/group')
  @ApiOperation({ description: '创建群聊房间（同时实时通知所有成员）' })
  async createGroupRoom(
    @CurrentUser() user: ChatUser,
    @Body() dto: CreateGroupRoomDto,
  ) {
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
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Post('rooms/private')
  @ApiOperation({
    description: '发起或获取与指定用户的私聊会话（同时实时通知双方）',
  })
  async createPrivateRoom(
    @CurrentUser() user: ChatUser,
    @Body() dto: InitPrivateRoomDto,
  ) {
    try {
      const room = await this.chatService.getOrCreatePrivateRoom(
        user.id,
        dto.receiverId,
      );
      this.chatGateway.emitToUsers(
        room.members.map((member) => member.userId),
        'room:private',
        room,
      );
      return { message: '私聊会话获取成功', result: true, data: room };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Get('rooms')
  @ApiOperation({
    description: '获取当前用户的会话列表（群聊+私聊，含最后一条消息与未读数）',
  })
  async listConversations(@CurrentUser() user: ChatUser) {
    try {
      const data = await this.chatService.listConversations(user.id);
      return { message: '会话列表获取成功', result: true, data };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({
    description: '分页获取某个聊天室的历史消息（自动过滤已清空的消息）',
  })
  async getMessages(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Query() query: HistoryQueryDto,
  ) {
    try {
      const data = await this.chatService.getMessages(user.id, {
        roomId,
        take: query.take,
      });
      return { message: '历史消息获取成功', result: true, data };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Get('rooms/:roomId/messages/sync')
  @ApiOperation({
    description: '按消息游标增量同步聊天室消息（用于断线重连补齐）',
  })
  async syncMessages(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Query() query: SyncMessagesQueryDto,
  ) {
    try {
      const data = await this.chatService.syncMessages(user.id, {
        roomId,
        afterMessageId: query.afterMessageId,
        take: query.take,
      });
      return { message: '消息同步成功', result: true, data };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Get('rooms/:roomId/members')
  @ApiOperation({ description: '获取某个聊天室的成员列表' })
  async getRoomMembers(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
  ) {
    try {
      const data = await this.chatService.getRoomMembers(roomId, user.id);
      return { message: '成员列表获取成功', result: true, data };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Post('rooms/:roomId/read')
  @ApiOperation({
    description: '将某个聊天室标记为已读（同时实时同步给房间内成员）',
  })
  async markRead(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
  ) {
    try {
      const result = await this.chatService.markRoomRead(user.id, roomId);
      this.chatGateway.emitToRoom(roomId, 'room:read', {
        roomId,
        userId: user.id,
        lastReadAt: result.lastReadAt,
      });
      return { message: '已读设置成功', result: true, data: result };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Post('rooms/:roomId/clear')
  @ApiOperation({
    description:
      '清空当前用户在该聊天室的聊天记录（仅对当前用户隐藏，不删除原消息）',
  })
  async clearRoom(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
  ) {
    try {
      const result = await this.chatService.clearRoom(user.id, roomId);
      return { message: '聊天记录已清空', result: true, data: result };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Post('rooms/:roomId/leave')
  @ApiOperation({
    description: '退出群聊（群主退出自动转让群主，最后一人退出则归档房间）',
  })
  async leaveRoom(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
  ) {
    try {
      const result = await this.chatService.leaveRoom(user.id, roomId);
      // 通知剩余成员：有成员离开 / 群主变更，前端刷新会话列表与成员数
      this.chatGateway.emitToUsers(result.remainingMemberIds, 'member:left', {
        roomId,
        userId: user.id,
        newOwnerId: result.newOwnerId,
        disbanded: result.disbanded,
      });
      // 通知离开者本人：前端清理本地会话（乐观移除的兜底）
      this.chatGateway.emitToUser(user.id, 'room:left', { roomId });
      return {
        message: result.disbanded ? '群聊已解散' : '已退出群聊',
        result: true,
        data: result,
      };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }

  @Post('rooms/:roomId/members')
  @ApiOperation({
    description: '邀请好友加入群聊（直接加成员，并实时通知新成员与既有成员）',
  })
  async addMembers(
    @CurrentUser() user: ChatUser,
    @Param('roomId') roomId: string,
    @Body() dto: AddMembersDto,
  ) {
    try {
      const { room, addedMemberIds } = await this.chatService.addMembers(
        user.id,
        roomId,
        dto.memberIds,
      );
      if (room) {
        // 新成员：复用 room:created 让其会话列表出现该群（前端已有监听）
        this.chatGateway.emitToUsers(addedMemberIds, 'room:created', room);
        // 既有成员（含邀请者）：成员数变更，刷新会话列表
        const existingIds = room.members
          .filter(
            (m) => m.status === 'ACTIVE' && !addedMemberIds.includes(m.userId),
          )
          .map((m) => m.userId);
        this.chatGateway.emitToUsers(existingIds, 'member:joined', {
          roomId,
          userIds: addedMemberIds,
        });
      }
      return {
        message: '成员邀请成功',
        result: true,
        data: { addedMemberIds },
      };
    } catch (error) {
      this.logger.error(error);
      return { message: SERVICE_ERROR_MESSAGE, result: false, data: null };
    }
  }
}
