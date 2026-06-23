import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import commonConfig from '../config/common';
import { BullModule } from '@nestjs/bull';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { UserModule } from './user/user.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';

const suffix = process.env.NODE_ENV ?? 'development';

@Module({
  imports: [
    // 全局模块（提供 PrismaService、RedisService、EmailService）
    CommonModule,
    // 配置模块
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${suffix}`, '.env'],
      load: [commonConfig],
    }),

    // Redis队列
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }),
      inject: [ConfigService],
    }),
    // 静态文件
    ServeStaticModule.forRootAsync({
      useFactory: () => [
        {
          rootPath: join(__dirname, '..', 'uploads'),
          serveRoot: '/uploads',
        },
      ],
    }),
    AuthModule,
    UserModule,
  ],
})
export class AppModule {}