import { Controller, Get, Inject, Query } from '@nestjs/common';
import * as Minio from 'minio';

@Controller('minio')
export class MinioController {
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

  @Get('previewUrl')
  async previewObject(@Query('name') name: string) {
    try {
      const previewUrl = await this.minioClient.presignedGetObject(
        'public', 
        name, 
        3600,
        { "response-content-disposition": "inline" } // 关键：内嵌预览，不下载
      );
      console.log(previewUrl);
      return {
        message: '预览URL生成成功',
        result: true,
        data: {
          url: previewUrl,
        }
      };
    } catch (error) {
      console.error('Error generating preview URL:', error);
      return {
        message: '预览URL生成失败',
        result: false,
        data: null,
      };
    }
  }
}
