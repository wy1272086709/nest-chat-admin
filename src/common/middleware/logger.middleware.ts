import { Request, Response, NextFunction } from 'express';

// 函数式中间件，可以在 main.ts 中直接使用
export function loggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const { method, url, query } = req;
  const userAgent = req.get('user-agent') || '';

  console.log(`[${new Date().toISOString()}] ${method} ${url}`);
  console.log(`Query:`, query);
  console.log(`User-Agent: ${userAgent}`);

  res.on('finish', () => {
    const { statusCode } = res;
    console.log(`[${new Date().toISOString()}] ${method} ${url} - ${statusCode}`);
  });

  next();
}

// 保留类式中间件以便在模块中使用（如果需要）
import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    loggerMiddleware(req, res, next);
  }
}