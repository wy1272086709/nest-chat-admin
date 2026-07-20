import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";

export type WsError = {
  result: false;
  code: BusinessErrorCode;
  message: string;
};

export function createWsErrorResponse(
  error: unknown,
  fallbackMessage = "服务异常，请稍后再试",
): WsError {
  if (error instanceof BusinessException) {
    return {
      result: false,
      code: error.businessCode,
      message: error.message,
    };
  }

  return {
    result: false,
    code: BusinessErrorCode.INTERNAL_ERROR,
    message: fallbackMessage,
  };
}
