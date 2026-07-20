import { HttpException, HttpStatus } from '@nestjs/common';
import { BusinessErrorCode } from '../constants/business-error-code.constant';

export class BusinessException extends HttpException {
  constructor(
    readonly businessCode: BusinessErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ businessCode, message, details }, status);
  }
}
