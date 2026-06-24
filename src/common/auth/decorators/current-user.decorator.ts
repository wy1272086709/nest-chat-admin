import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ChatUser } from '@prisma/client';

/**
 * 获取当前登录用户的装饰器
 * 使用方法：
 * - @CurrentUser() user: ChatUser - 获取完整用户对象
 * - @CurrentUser('email') email: string - 只获取指定字段
 *
 * @param data 可选的字段名，如果提供则只返回该字段的值
 * @returns 用户对象或指定字段的值
 */
export const CurrentUser = createParamDecorator(
  (data: keyof ChatUser | undefined, ctx: ExecutionContext): ChatUser | any => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    // 如果指定了字段，只返回该字段的值
    return data ? user?.[data] : user;
  },
);