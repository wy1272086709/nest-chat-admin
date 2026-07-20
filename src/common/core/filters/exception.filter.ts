import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BusinessErrorCode } from '../constants/business-error-code.constant';
import { BusinessException } from '../exceptions/business.exception';
import { createErrorResponse } from '../responses/response.factory';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let businessCode = BusinessErrorCode.INTERNAL_ERROR;

    if (exception instanceof BusinessException) {
      status = exception.getStatus();
      message = exception.message;
      businessCode = exception.businessCode;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse() as any;
      message = errorResponse?.message ?? message;
      // 处理校验错误的数组消息
      if (Array.isArray(message) && message.length > 0) {
        message = message[0];
      }
      businessCode = this.getDefaultBusinessCode(status);
    }

    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // 与 TransformInterceptor 的成功响应保持同一套字段（result/code/data/message），
    // 额外保留 path 作为调试辅助，便于定位异常请求。
    const requestId = request.headers['x-request-id'];
    const responseBody = createErrorResponse({
      code: businessCode,
      message: typeof exception === 'string' ? exception : message,
      path: request.url,
      requestId: typeof requestId === 'string' ? requestId : undefined,
    });

    response.status(status).json(responseBody);
  }

  private getDefaultBusinessCode(status: number) {
    if (status === HttpStatus.BAD_REQUEST) {
      return BusinessErrorCode.VALIDATION_FAILED;
    }
    if (status === HttpStatus.UNAUTHORIZED) {
      return BusinessErrorCode.AUTH_UNAUTHORIZED;
    }
    if (status === HttpStatus.FORBIDDEN) {
      return BusinessErrorCode.AUTH_FORBIDDEN;
    }
    return BusinessErrorCode.COMMON_HTTP_ERROR;
  }
}
