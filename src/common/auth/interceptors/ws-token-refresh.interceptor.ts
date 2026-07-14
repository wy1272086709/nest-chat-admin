import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { EMPTY, Observable } from 'rxjs';
import { Socket } from 'socket.io';
import { AuthService } from '../services/auth.service';

type SocketUser = {
  id: string;
  email: string;
  username: string;
};

type RefreshableSocket = Socket & {
  data: {
    user?: SocketUser;
    tokenExpiresAt?: number;
    lastTokenRefreshAt?: number;
    tokenJti?: string;
  };
};

@Injectable()
export class WsTokenRefreshInterceptor implements NestInterceptor {
  private readonly refreshThresholdMs = 24 * 60 * 60 * 1000;
  private readonly refreshCooldownMs = 60 * 1000;

  constructor(private readonly authService: AuthService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'ws') {
      return next.handle();
    }

    const client = context.switchToWs().getClient<RefreshableSocket>();
    try {
      await this.assertSessionUsable(client);
      await this.refreshTokenIfNeeded(client);
    } catch (error) {
      this.disconnectForAuthFailure(client, error);
      return EMPTY;
    }

    return next.handle();
  }

  private async assertSessionUsable(client: RefreshableSocket) {
    const user = client.data.user;
    if (!user) {
      return;
    }

    await this.authService.validateUserSession(user.id, client.data.tokenJti);
  }

  private async refreshTokenIfNeeded(client: RefreshableSocket) {
    const user = client.data.user;
    const tokenExpiresAt = client.data.tokenExpiresAt;
    const tokenJti = client.data.tokenJti;

    if (!user || !tokenExpiresAt || !tokenJti) {
      return;
    }

    const now = Date.now();
    const timeUntilExpiry = tokenExpiresAt - now;
    if (timeUntilExpiry > this.refreshThresholdMs) {
      return;
    }

    const lastTokenRefreshAt = client.data.lastTokenRefreshAt ?? 0;
    if (now - lastTokenRefreshAt < this.refreshCooldownMs) {
      return;
    }

    const refreshedToken = await this.authService.refreshAccessToken(
      {
        ...user,
        status: 'ACTIVE',
      },
      tokenJti,
    );
    const nextExpiresAt = Date.parse(refreshedToken.expires_at);

    client.data.tokenExpiresAt = nextExpiresAt;
    client.data.lastTokenRefreshAt = now;
    client.emit('auth:tokenRefreshed', {
      access_token: refreshedToken.access_token,
      token_type: refreshedToken.token_type,
      expires_at: refreshedToken.expires_at,
      expires_in: refreshedToken.expires_in,
    });
  }

  private disconnectForAuthFailure(client: RefreshableSocket, error: any) {
    const message = '登录状态已失效';
    const event = message.includes('禁用') ? 'auth:disabled' : 'auth:kicked';
    client.emit(event, { message });
    client.disconnect();
  }
}
