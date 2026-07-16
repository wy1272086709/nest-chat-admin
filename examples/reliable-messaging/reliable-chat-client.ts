import { io, Socket } from 'socket.io-client';

type MessageType = 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO';
type PendingStatus = 'pending' | 'sending' | 'failed';

export type ChatMessage = {
  id: string;
  roomId: string;
  senderId: string;
  clientMessageId?: string | null;
  content?: string | null;
  messageType: MessageType;
  fileUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileType?: string | null;
  thumbnailUrl?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  duration?: number | null;
  createdAt: string;
};

export type MessagePayload = {
  content?: string;
  messageType?: MessageType;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  thumbnailUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
};

export type PendingMessage = {
  localId: string;
  clientMessageId: string;
  event: 'message:sendRoom' | 'message:sendPrivate';
  payload: (MessagePayload & { roomId: string }) | (MessagePayload & { receiverId: string });
  status: PendingStatus;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

type ApiResponse<T> = {
  result: boolean;
  code: number;
  data: T;
  message?: string;
};

type SyncResponse = {
  messages: ChatMessage[];
  nextCursor: { messageId: string; createdAt: string } | null;
  hasMore: boolean;
};

type ReliableChatClientOptions = {
  apiBaseUrl: string;
  socketUrl: string;
  getToken: () => string | null | Promise<string | null>;
  currentUserId?: string;
  storageKey?: string;
  ackTimeoutMs?: number;
  retryIntervalMs?: number;
  onMessage?: (message: ChatMessage) => void;
  onQueueChange?: (queue: PendingMessage[]) => void;
  onError?: (error: Error) => void;
};

export class ReliableChatClient {
  private socket: Socket | null = null;
  private queue: PendingMessage[] = [];
  private seenMessageIds = new Set<string>();
  private roomCursors: Record<string, string> = {};
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly storageKey: string;
  private readonly ackTimeoutMs: number;
  private readonly retryIntervalMs: number;

  constructor(private readonly options: ReliableChatClientOptions) {
    this.storageKey = options.storageKey ?? 'reliable-chat';
    this.ackTimeoutMs = options.ackTimeoutMs ?? 8000;
    this.retryIntervalMs = options.retryIntervalMs ?? 5000;
    this.restoreState();
  }

  async connect() {
    const token = await this.options.getToken();
    this.socket = io(this.options.socketUrl, {
      auth: {
        token,
      },
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      void this.syncKnownRooms();
      void this.retryPending();
      this.startRetryLoop();
    });

    this.socket.on('disconnect', () => {
      this.stopRetryLoop();
    });

    this.socket.on('message:new', (message: ChatMessage) => {
      this.acceptMessage(message);
    });

    this.socket.on('connect_error', (error) => {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  disconnect() {
    this.stopRetryLoop();
    this.socket?.disconnect();
    this.socket = null;
  }

  sendRoomMessage(roomId: string, payload: MessagePayload) {
    return this.enqueue('message:sendRoom', {
      ...payload,
      roomId,
    });
  }

  sendPrivateMessage(receiverId: string, payload: MessagePayload) {
    return this.enqueue('message:sendPrivate', {
      ...payload,
      receiverId,
    });
  }

  async syncRoom(roomId: string, afterMessageId = this.roomCursors[roomId], take = 100) {
    const params = new URLSearchParams();
    if (afterMessageId) params.set('afterMessageId', afterMessageId);
    params.set('take', String(take));

    const response = await this.fetchApi<SyncResponse>(
      `/api/chat/rooms/${encodeURIComponent(roomId)}/messages/sync?${params.toString()}`,
    );

    for (const message of response.messages) {
      this.acceptMessage(message);
    }

    return response;
  }

  async markRoomRead(roomId: string) {
    return this.fetchApi(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, {
      method: 'POST',
    });
  }

  getPendingQueue() {
    return [...this.queue];
  }

  private enqueue(event: PendingMessage['event'], payload: PendingMessage['payload']) {
    const pending: PendingMessage = {
      localId: this.createId(),
      clientMessageId: this.createId(),
      event,
      payload,
      status: 'pending',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.queue.push(pending);
    this.persistQueue();
    void this.emitPending(pending);
    return pending;
  }

  private async emitPending(pending: PendingMessage) {
    if (!this.socket?.connected) {
      this.updatePending(pending.clientMessageId, { status: 'pending' });
      return;
    }

    this.updatePending(pending.clientMessageId, {
      status: 'sending',
      retryCount: pending.retryCount + 1,
    });

    try {
      const message = await this.emitWithAck<ChatMessage>(pending.event, {
        ...pending.payload,
        clientMessageId: pending.clientMessageId,
      });

      this.removePending(pending.clientMessageId);
      this.acceptMessage(message);
    } catch (error) {
      this.updatePending(pending.clientMessageId, { status: 'pending' });
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket 未连接'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error('消息发送确认超时'));
      }, this.ackTimeoutMs);

      socket.emit(event, payload, (ack: { result: boolean; data?: T; message?: string }) => {
        clearTimeout(timer);

        if (!ack?.result || !ack.data) {
          reject(new Error(ack?.message || '消息发送失败'));
          return;
        }

        resolve(ack.data);
      });
    });
  }

  private acceptMessage(message: ChatMessage) {
    if (!message?.id) return;
    if (this.seenMessageIds.has(message.id)) return;

    this.seenMessageIds.add(message.id);
    this.roomCursors[message.roomId] = message.id;
    this.persistCursors();

    this.options.onMessage?.(message);

    if (!this.options.currentUserId || message.senderId !== this.options.currentUserId) {
      this.markDelivered(message.roomId, message.id);
    }
  }

  private markDelivered(roomId: string, messageId: string) {
    if (!this.socket?.connected) return;

    this.socket.emit('message:delivered', {
      roomId,
      messageId,
    });
  }

  private async syncKnownRooms() {
    const roomIds = new Set(Object.keys(this.roomCursors));

    try {
      const conversations = await this.fetchApi<Array<{ room: { id: string } }>>('/api/chat/rooms');
      for (const item of conversations) {
        if (item?.room?.id) roomIds.add(item.room.id);
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }

    for (const roomId of roomIds) {
      try {
        await this.syncRoom(roomId);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async retryPending() {
    const pendingItems = this.queue.filter((item) => item.status !== 'sending');
    for (const item of pendingItems) {
      await this.emitPending(item);
    }
  }

  private startRetryLoop() {
    if (this.retryTimer) return;

    this.retryTimer = setInterval(() => {
      void this.retryPending();
    }, this.retryIntervalMs);
  }

  private stopRetryLoop() {
    if (!this.retryTimer) return;

    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  private updatePending(clientMessageId: string, patch: Partial<PendingMessage>) {
    this.queue = this.queue.map((item) =>
      item.clientMessageId === clientMessageId
        ? {
            ...item,
            ...patch,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    this.persistQueue();
  }

  private removePending(clientMessageId: string) {
    this.queue = this.queue.filter((item) => item.clientMessageId !== clientMessageId);
    this.persistQueue();
  }

  private async fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.options.getToken();
    const response = await fetch(`${this.options.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });

    const body = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !body.result) {
      throw new Error(body.message || '请求失败');
    }

    return body.data;
  }

  private restoreState() {
    if (!this.hasStorage()) return;

    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const state = JSON.parse(raw) as {
        queue?: PendingMessage[];
        roomCursors?: Record<string, string>;
      };

      this.queue = state.queue ?? [];
      this.roomCursors = state.roomCursors ?? {};
    } catch {
      this.queue = [];
      this.roomCursors = {};
    }
  }

  private persistQueue() {
    this.persistState();
    this.options.onQueueChange?.(this.getPendingQueue());
  }

  private persistCursors() {
    this.persistState();
  }

  private persistState() {
    if (!this.hasStorage()) return;

    localStorage.setItem(
      this.storageKey,
      JSON.stringify({
        queue: this.queue,
        roomCursors: this.roomCursors,
      }),
    );
  }

  private hasStorage() {
    return typeof localStorage !== 'undefined';
  }

  private createId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private emitError(error: Error) {
    this.options.onError?.(error);
  }
}
