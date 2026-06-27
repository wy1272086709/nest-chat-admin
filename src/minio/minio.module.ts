import { Global, Module } from '@nestjs/common';
import * as Minio from 'minio';
import { MinioController } from './minio.controller';

@Global()
@Module({
    providers: [
        {
          provide: 'MINIO_CLIENT',
          async useFactory() {
            const client = new Minio.Client({
              endPoint: 'localhost',
              port: 9000,
              useSSL: false,
              accessKey: 'admin',
              secretKey: '910029Abc##'
            })
            return client;
          }
        }
    ],
    exports: ['MINIO_CLIENT'],
    imports: [],
    controllers: [MinioController]
})
export class MinioModule {}
