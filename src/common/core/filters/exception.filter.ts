import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse() as any;
      message = errorResponse?.message ?? message;
      // 处理校验错误的数组消息
      if (Array.isArray(message) && message.length > 0) {
        message = message[0];
      }
    }

    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${message}`,
      exception instanceof Error ? exception.stack : undefined
    );

    // 与 TransformInterceptor 的成功响应保持同一套字段（result/code/data/message），
    // 额外保留 path 作为调试辅助，便于定位异常请求。
    const responseBody = {
      result: false,
      code: status,
      data: null,
      message: typeof exception === 'string' ? exception : message,
      path: request.url,
    };

    response.status(status).json(responseBody);
  }
}