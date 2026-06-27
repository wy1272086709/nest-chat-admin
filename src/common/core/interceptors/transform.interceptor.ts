import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// 最终返回响应的格式
export interface Response<T> {
  result: boolean;
  code: number;
  data: T;
  message?: string;
}

export interface DataResult<T extends Record<string, any> | null> {
  data: T;
  message?: string;
  result: boolean;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<DataResult<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<DataResult<T>>
  ): Observable<Response<DataResult<T>> | any> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();

    // 统一设置状态码为 200
    response.status(200);

    return next.handle().pipe(
      map((data) => {
        return {
          // 判断请求成功与否
          result: data.result,
          code: 0,
          data: data.data,
          message: data?.message,
        };
      })
    );
  }
}