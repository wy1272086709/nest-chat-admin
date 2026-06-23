import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 标记路由为公开访问，不需要JWT认证
 * 使用方法：在Controller方法上添加 @Public() 装饰器
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);