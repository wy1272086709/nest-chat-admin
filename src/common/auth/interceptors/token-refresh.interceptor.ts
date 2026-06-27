import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { Observable } from 'rxjs';

@Injectable()
export class TokenRefreshInterceptor implements NestInterceptor {
  constructor(private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse();

    // 从 Authorization header 中获取 token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next.handle();
    }

    if (!request.user) {
      return next.handle();
    }

    const token = authHeader.substring(7);
    const decoded = this.jwtService.decode(token) as any;

    if (!decoded?.exp) {
      return next.handle();
    }

    const expTime = decoded.exp * 1000;
    const timeUntilExpiry = expTime - Date.now();
    const refreshThreshold = 24 * 60 * 60 * 1000;

    if (timeUntilExpiry > 0 && timeUntilExpiry < refreshThreshold) {
      const user = request.user as any;
      const newToken = this.jwtService.sign(
        {
          sub: user.id,
          email: user.email,
          username: user.username,
        },
        {
          expiresIn: this.configService.get('jwt.expiresIn'),
        },
      );

      response.setHeader('Authorization', 'Bearer ' + newToken);
      response.setHeader('Refresh-Token', 'true');
    }

    return next.handle();
  }
}
