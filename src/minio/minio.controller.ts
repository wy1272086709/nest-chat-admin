import { Controller, Get, Inject, Query } from '@nestjs/common';
import * as Minio from 'minio';

@Controller('minio')
export class MinioController {
  @Inject('MINIO_CLIENT')
  private minioClient: Minio.Client;

  @Get('presignedUrl')
  async presignedPutObject(@Query('name') name: string) {
    try {
      const presignedUrl = await this.minioClient.presignedPutObject('public', name, 3600);
      console.log(presignedUrl);
      return {
        message: '预签名URL生成成功',
        result: true,
        data: {
          url: presignedUrl,
        }
      };
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      throw error;
    }
  }
}
