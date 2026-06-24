import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class TokenRefreshInterceptor implements NestInterceptor {
  constructor(private readonly jwtService: JwtService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse();

    // 从 Authorization header 中获取 token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next.handle();
    }

    const token = authHeader.substring(7);

    try {
      // 解码 token（不验证，只是读取信息）
      const decoded = this.jwtService.decode(token) as any;

      if (!decoded || !decoded.exp) {
        return next.handle();
      }

      // 计算过期时间
      const expTime = decoded.exp * 1000; // 转换为毫秒
      const now = Date.now();
      const timeUntilExpiry = expTime - now;

      // 如果距离过期不足 24 小时（86400000 毫秒），自动刷新 token
      const REFRESH_THRESHOLD = 24 * 60 * 60 * 1000; // 24 小时

      if (timeUntilExpiry > 0 && timeUntilExpiry < REFRESH_THRESHOLD) {
        // 生成新的 token，保持相同的 payload
        const newPayload = {
          sub: decoded.sub,
          email: decoded.email,
          username: decoded.username,
        };

        const newToken = this.jwtService.sign(newPayload, {
          expiresIn: '7d',
        });

        // 在响应头中添加新 token
        response.setHeader('X-New-Token', newToken);
        response.setHeader('X-Token-Refreshed', 'true');
      }
    } catch (error) {
      // 如果解码失败，继续正常处理请求
      console.log('Token refresh error:', error.message);
    }

    return next.handle();
  }
}
