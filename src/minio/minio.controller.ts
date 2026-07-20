import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Query,
} from "@nestjs/common";
import * as Minio from "minio";
import { BusinessErrorCode } from "@/common/core/constants/business-error-code.constant";
import { BusinessException } from "@/common/core/exceptions/business.exception";

@Controller("minio")
export class MinioController {
  private readonly logger = new Logger(MinioController.name);

  @Inject("MINIO_PUBLIC_CLIENT")
  private minioPublicClient: Minio.Client;

  @Get("presignedUrl")
  async presignedPutObject(@Query("name") name: string) {
    const url = await this.generatePresignedUrl(
      name,
      "minio.presigned_put_url",
      () => this.minioPublicClient.presignedPutObject("public", name, 3600),
    );
    return { message: "预签名URL生成成功", result: true, data: { url } };
  }

  @Get("previewUrl")
  async previewObject(@Query("name") name: string) {
    const url = await this.generatePresignedUrl(name, "minio.preview_url", () =>
      this.minioPublicClient.presignedGetObject("public", name, 3600, {
        "response-content-disposition": "inline",
      }),
    );
    return { message: "预览URL生成成功", result: true, data: { url } };
  }

  private async generatePresignedUrl(
    objectName: string,
    event: string,
    operation: () => Promise<string>,
  ) {
    try {
      const url = await operation();
      this.logger.debug({ event: `${event}_created`, objectName });
      return url;
    } catch (error) {
      this.logger.error({ event: `${event}_failed`, objectName, err: error });
      if (error instanceof BusinessException) throw error;
      throw new BusinessException(
        BusinessErrorCode.STORAGE_OPERATION_FAILED,
        "对象存储操作失败",
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
