import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService } from '@/common/auth/services/auth.service';
import { ChatService } from './chat.service';
import { CreateGroupRoomDto, GetMessagesDto, RoomIdDto, SendPrivateMessageDto, SendRoomMessageDto } from './dto/chat.dto';

type AuthenticatedSocket = Socket & {
  data: {
    user?: {
      id: string;
      email: string;
      username: string;
    };
  };
};

@WebSocketGateway({
  namespace: 'chat',
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly authService: AuthService,
    private readonly chatService: ChatService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = this.getToken(client);
      if (!token) {
        client.emit('chat:error', { message: '缺少 token' });
        client.disconnect();
        return;
      }

      const payload = await this.authService.verifyToken(token);
      const user = await this.authService.getUserById(payload.sub);
      if (!user) {
        client.emit('chat:error', { message: '用户不存在' });
        client.disconnect();
        return;
      }

      client.data.user = {
        id: user.id,
        email: user.email,
        username: user.username,
      };
      await client.join(`user:${user.id}`);
      client.emit('chat:connected', { userId: user.id });
    } catch (error) {
      client.emit('chat:error', { message: error.message || '连接认证失败' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data.user?.id;
    if (userId) {
      client.leave(`user:${userId}`);
    }
  }

  @SubscribeMessage('room:join')
  async joinRoom(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: RoomIdDto) {
    const userId = this.getUserId(client);
    await this.chatService.assertRoomMember(body.roomId, userId);
    await client.join(`room:${body.roomId}`);
    return { event: 'room:joined', data: { roomId: body.roomId } };
  }

  @SubscribeMessage('room:createGroup')
  async createGroupRoom(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: CreateGroupRoomDto) {
    const userId = this.getUserId(client);
    const room = await this.chatService.createGroupRoom(userId, body);
    await client.join(`room:${room.id}`);

    for (const member of room.members) {
      this.server.to(`user:${member.userId}`).emit('room:created', room);
    }

    return { event: 'room:created', data: room };
  }

  @SubscribeMessage('message:sendRoom')
  async sendRoomMessage(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: SendRoomMessageDto) {
    const userId = this.getUserId(client);
    const message = await this.chatService.sendRoomMessage(userId, body);
    this.server.to(`room:${body.roomId}`).emit('message:new', message);
    return { event: 'message:sent', data: message };
  }

  @SubscribeMessage('message:sendPrivate')
  async sendPrivateMessage(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: SendPrivateMessageDto) {
    const userId = this.getUserId(client);
    const result = await this.chatService.sendPrivateMessage(userId, body);

    await client.join(`room:${result.room.id}`);

    for (const member of result.room.members) {
      this.server.to(`user:${member.userId}`).emit('room:private', result.room);
      this.server.to(`user:${member.userId}`).emit('message:new', result.message);
    }

    this.server.to(`room:${result.room.id}`).emit('message:new', result.message);
    return { event: 'message:sent', data: result };
  }

  @SubscribeMessage('message:list')
  async getMessages(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: GetMessagesDto) {
    const userId = this.getUserId(client);
    const messages = await this.chatService.getMessages(userId, body);
    return { event: 'message:list', data: messages };
  }

  @SubscribeMessage('room:read')
  async markRoomRead(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: RoomIdDto) {
    const userId = this.getUserId(client);
    const result = await this.chatService.markRoomRead(userId, body.roomId);
    this.server.to(`room:${body.roomId}`).emit('room:read', {
      roomId: body.roomId,
      userId,
      lastReadAt: result.lastReadAt,
    });
    return { event: 'room:read', data: result };
  }

  @SubscribeMessage('room:clear')
  async clearRoom(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() body: RoomIdDto) {
    const userId = this.getUserId(client);
    const result = await this.chatService.clearRoom(userId, body.roomId);
    client.emit('room:cleared', result);
    return { event: 'room:cleared', data: result };
  }

  // ===== 对外暴露的推送方法 =====
  // 供 HTTP Controller 复用：让走 HTTP 的操作（建群、已读等）也能实时同步到在线客户端。
  // 内部 WS 事件仍直接用 this.server 推送，互不影响。

  /** 向单个用户推送事件（通过其私有 user room） */
  emitToUser(userId: string, event: string, payload: unknown) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  /** 向多个用户推送事件 */
  emitToUsers(userIds: string[], event: string, payload: unknown) {
    userIds.forEach((userId) => this.emitToUser(userId, event, payload));
  }

  /** 向某个聊天室所有在线成员推送事件 */
  emitToRoom(roomId: string, event: string, payload: unknown) {
    this.server.to(`room:${roomId}`).emit(event, payload);
  }

  private getToken(client: Socket) {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string') {
      return authToken.replace(/^Bearer\s+/i, '');
    }

    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.substring(7);
    }

    return null;
  }

  private getUserId(client: AuthenticatedSocket) {
    const userId = client.data.user?.id;
    if (!userId) {
      throw new Error('Socket 未认证');
    }
    return userId;
  }
}
