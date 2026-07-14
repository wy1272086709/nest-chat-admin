import { Controller, Get, Inject, Logger, Query } from '@nestjs/common';
import * as Minio from 'minio';

@Controller('minio')
export class MinioController {
  private readonly logger = new Logger(MinioController.name);

  @Inject('MINIO_CLIENT')
  private minioClient: Minio.Client;

  @Get('presignedUrl')
  async presignedPutObject(@Query('name') name: string) {
    try {
      const presignedUrl = await this.minioClient.presignedPutObject(
        'public', 
        name, 
        3600,
      );
      this.logger.debug({ event: 'minio.presigned_put_url_created', objectName: name });
      return {
        message: '预签名URL生成成功',
        result: true,
        data: {
          url: presignedUrl,
        }
      };
    } catch (error) {
      this.logger.error({
        event: 'minio.presigned_put_url_failed',
        objectName: name,
        err: error,
      });
      throw error;
    }
  }

  @Get('previewUrl')
  async previewObject(@Query('name') name: string) {
    try {
      const previewUrl = await this.minioClient.presignedGetObject(
        'public', 
        name, 
        3600,
        { "response-content-disposition": "inline" } // 关键：内嵌预览，不下载
      );
      this.logger.debug({ event: 'minio.preview_url_created', objectName: name });
      return {
        message: '预览URL生成成功',
        result: true,
        data: {
          url: previewUrl,
        }
      };
    } catch (error) {
      this.logger.error({
        event: 'minio.preview_url_failed',
        objectName: name,
        err: error,
      });
      return {
        message: '预览URL生成失败',
        result: false,
        data: null,
      };
    }
  }
}
