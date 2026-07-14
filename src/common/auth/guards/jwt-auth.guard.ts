import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  /**
   * 检查路由是否可以访问
   * @param context 执行上下文
   * @returns 是否允许访问
   */
  canActivate(context: ExecutionContext) {
    // 检查是否标记为@Public()路由
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 如果是公开路由，直接允许访问
    if (isPublic) {
      return true;
    }

    // 否则执行JWT认证
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    if (err) {
      throw err;
    }

    if (user) {
      return user;
    }

    if (info?.name === 'TokenExpiredError') {
      throw new UnauthorizedException('Token 已过期，请重新登录');
    }

    if (info?.name === 'JsonWebTokenError') {
      throw new UnauthorizedException('Token 无效，请重新登录');
    }

    if (info?.message === 'No auth token') {
      throw new UnauthorizedException('缺少 Authorization 请求头');
    }

    throw new UnauthorizedException('认证失败，请重新登录');
  }
}
