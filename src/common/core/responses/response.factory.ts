import { BusinessErrorCode } from '../constants/business-error-code.constant';

export function createSuccessResponse<T>(params: {
  data: T;
  message?: string;
  result?: boolean;
}) {
  const result = params.result ?? true;
  return {
    result,
    code: result
      ? BusinessErrorCode.SUCCESS
      : BusinessErrorCode.COMMON_HTTP_ERROR,
    data: params.data,
    message: params.message,
  };
}

export function createErrorResponse(params: {
  code: BusinessErrorCode;
  message: string;
  path: string;
  requestId?: string;
}) {
  return {
    result: false,
    code: params.code,
    data: null,
    message: params.message,
    path: params.path,
    ...(params.requestId ? { requestId: params.requestId } : {}),
  };
}
