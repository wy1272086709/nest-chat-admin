import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import { MinioController } from './minio.controller';

@Global()
@Module({
  providers: [
    {
      provide: 'MINIO_CLIENT',
      useFactory(configService: ConfigService) {
        return new Minio.Client({
          endPoint: configService.get<string>('minio.endPoint', 'localhost'),
          port: configService.get<number>('minio.port', 9000),
          useSSL: configService.get<boolean>('minio.useSSL', false),
          accessKey: configService.get<string>('minio.accessKey', 'minioadmin'),
          secretKey: configService.get<string>('minio.secretKey', 'minioadmin'),
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ['MINIO_CLIENT'],
  imports: [],
  controllers: [MinioController],
})
export class MinioModule {}
