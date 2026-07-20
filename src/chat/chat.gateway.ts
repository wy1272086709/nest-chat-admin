import { Logger, UseFilters, UseInterceptors } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { AuthService } from "@/common/auth/services/auth.service";
import { WsTokenRefreshInterceptor } from "@/common/auth/interceptors/ws-token-refresh.interceptor";
import { ChatService } from "./chat.service";
import {
  CreateGroupRoomDto,
  DeliveredMessageDto,
  GetMessagesDto,
  RoomIdDto,
  SendPrivateMessageDto,
  SendRoomMessageDto,
  SyncMessagesDto,
} from "./dto/chat.dto";
import { MessageModerationRejectedException } from "./chat-moderation.service";
import { ChatUserMutedException } from "./chat-restriction.service";
import { createWsErrorResponse } from "./ws-error-response";
import { WsExceptionFilter } from "./ws-exception.filter";

type AuthenticatedSocket = Socket & {
  data: {
    user?: {
      id: string;
      email: string;
      username: string;
    };
    tokenExpiresAt?: number;
    lastTokenRefreshAt?: number;
    tokenJti?: string;
  };
};

@WebSocketGateway({
  namespace: "chat",
  cors: {
    origin: "*",
  },
})
@UseInterceptors(WsTokenRefreshInterceptor)
@UseFilters(WsExceptionFilter)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

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
        client.emit("chat:error", { message: "缺少 token" });
        client.disconnect();
        return;
      }

      const payload = await this.authService.verifyToken(token);
      const user = await this.authService.validatePayload(payload);

      client.data.user = {
        id: user.id,
        email: user.email,
        username: user.username,
      };
      this.logger.debug({
        event: "chat.socket_token.resolved",
        tokenExpiresAt: payload.exp,
      });
      if (payload.exp) {
        client.data.tokenExpiresAt = payload.exp * 1000;
      }
      client.data.tokenJti = payload.jti;
      await client.join(`user:${user.id}`);
      client.emit("chat:connected", { userId: user.id });
    } catch (error) {
      this.logger.error(error);
      client.emit("chat:error", createWsErrorResponse(error));
      client.disconnect();
    }
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data.user?.id;
    if (userId) {
      client.leave(`user:${userId}`);
      await this.updateLastSeenIfOffline(userId);
    }
  }

  @SubscribeMessage("room:join")
  async joinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: RoomIdDto,
  ) {
    const userId = this.getUserId(client);
    await this.chatService.assertRoomMember(body.roomId, userId);
    await client.join(`room:${body.roomId}`);
    return { event: "room:joined", data: { roomId: body.roomId } };
  }

  @SubscribeMessage("room:createGroup")
  async createGroupRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: CreateGroupRoomDto,
  ) {
    const userId = this.getUserId(client);
    const room = await this.chatService.createGroupRoom(userId, body);
    await client.join(`room:${room.id}`);

    for (const member of room.members) {
      this.server.to(`user:${member.userId}`).emit("room:created", room);
    }

    return { event: "room:created", data: room };
  }

  @SubscribeMessage("message:sendRoom")
  async sendRoomMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SendRoomMessageDto,
  ) {
    try {
      const userId = this.getUserId(client);
      const result = await this.chatService.sendRoomMessage(userId, body);
      if (!result.isDuplicate) {
        this.server
          .to(`room:${body.roomId}`)
          .emit("message:new", result.message);
      }
      // 仍以事件形式回推 message:sent（保持「刷新会话列表」等已有行为，未升级客户端不受影响）
      client.emit("message:sent", result.message);
      // 返回普通对象 → socket.io ack：发送方若用 socket.emit(event, payload, cb) 发送，
      // cb 会收到 { result, data }，用于在客户端精确确认这一条消息的投递结果（替代以前的「发后即忘」）
      return { result: true, data: result.message };
    } catch (error) {
      this.logger.error(error);
      if (
        error instanceof MessageModerationRejectedException ||
        error instanceof ChatUserMutedException
      ) {
        return createWsErrorResponse(error);
      }
      return createWsErrorResponse(error);
    }
  }

  @SubscribeMessage("message:sendPrivate")
  async sendPrivateMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SendPrivateMessageDto,
  ) {
    try {
      const userId = this.getUserId(client);
      const result = await this.chatService.sendPrivateMessage(userId, body);

      await client.join(`room:${result.room.id}`);

      // 私聊房间是懒创建的，接收方还没 join 进 room:X，只能通过 user: 个人房间触达。
      // room:private 只负责把「房间元信息」同步给双方（刷新会话列表）；消息本身只发给接收方，
      // 发送方通过下面的 message:sent 事件 + 返回值 ack 拿到回执——
      // 避免「user: 循环 + room:」双推导致发送方重复收到。
      for (const member of result.room.members) {
        this.server
          .to(`user:${member.userId}`)
          .emit("room:private", result.room);
      }
      if (!result.isDuplicate) {
        this.server
          .to(`user:${body.receiverId}`)
          .emit("message:new", result.message);
      }
      client.emit("message:sent", result);
      // 返回 ack：cb 收到 { result, data }，data 为落库后的 message（含服务端 id）
      return { result: true, data: result.message };
    } catch (error) {
      this.logger.error(error);
      if (
        error instanceof MessageModerationRejectedException ||
        error instanceof ChatUserMutedException
      ) {
        return createWsErrorResponse(error);
      }
      return createWsErrorResponse(error);
    }
  }

  @SubscribeMessage("message:list")
  async getMessages(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: GetMessagesDto,
  ) {
    const userId = this.getUserId(client);
    const messages = await this.chatService.getMessages(userId, body);
    return { event: "message:list", data: messages };
  }

  @SubscribeMessage("message:sync")
  async syncMessages(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SyncMessagesDto,
  ) {
    try {
      const userId = this.getUserId(client);
      const data = await this.chatService.syncMessages(userId, body);
      return { result: true, event: "message:sync", data };
    } catch (error) {
      this.logger.error(error);
      return createWsErrorResponse(error);
    }
  }

  @SubscribeMessage("message:delivered")
  async markMessageDelivered(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: DeliveredMessageDto,
  ) {
    try {
      const userId = this.getUserId(client);
      const data = await this.chatService.markMessageDelivered(userId, body);
      return { result: true, event: "message:delivered", data };
    } catch (error) {
      this.logger.error(error);
      return createWsErrorResponse(error);
    }
  }

  @SubscribeMessage("room:read")
  async markRoomRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: RoomIdDto,
  ) {
    const userId = this.getUserId(client);
    const result = await this.chatService.markRoomRead(userId, body.roomId);
    this.server.to(`room:${body.roomId}`).emit("room:read", {
      roomId: body.roomId,
      userId,
      lastReadAt: result.lastReadAt,
    });
    return { event: "room:read", data: result };
  }

  @SubscribeMessage("room:clear")
  async clearRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: RoomIdDto,
  ) {
    const userId = this.getUserId(client);
    const result = await this.chatService.clearRoom(userId, body.roomId);
    client.emit("room:cleared", result);
    return { event: "room:cleared", data: result };
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

  disconnectUser(
    userId: string,
    message = "账号已在其他设备登录",
    event = "auth:kicked",
  ) {
    this.server.to(`user:${userId}`).emit(event, { message });
    this.server.in(`user:${userId}`).disconnectSockets(true);
  }

  private getToken(client: Socket) {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === "string") {
      return authToken.replace(/^Bearer\s+/i, "");
    }

    const header = client.handshake.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      return header.substring(7);
    }

    return null;
  }

  private getUserId(client: AuthenticatedSocket) {
    const userId = client.data.user?.id;
    if (!userId) {
      throw new Error("Socket 未认证");
    }
    return userId;
  }

  private async updateLastSeenIfOffline(userId: string) {
    try {
      const sockets = await this.server.in(`user:${userId}`).allSockets();
      if (sockets.size === 0) {
        await this.chatService.updateUserLastSeen(userId);
      }
    } catch (error) {
      this.logger.error({
        event: "chat.last_online_update.failed",
        userId,
        err: error,
      });
    }
  }
}
