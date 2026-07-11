import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_FILTER, APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import commonConfig from '../config/common';
import { BullModule } from '@nestjs/bull';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { UserModule } from './user/user.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './common/auth/auth-business.module';
import { TransformInterceptor } from './common/core/interceptors/transform.interceptor';
import { TokenRefreshInterceptor } from './common/auth/interceptors/token-refresh.interceptor';
import { GlobalExceptionFilter } from './common/core/filters/exception.filter';
import { JwtAuthGuard } from './common/auth/guards/jwt-auth.guard';
import { MinioModule } from './minio/minio.module';
import { NotificationModule } from './notification/notification.module';
import { ChatModule } from './chat/chat.module';
import { FavoriteModule } from './favorite/favorite.module';

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
    MinioModule,
    NotificationModule,
    ChatModule,
    FavoriteModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TokenRefreshInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector),
      inject: [Reflector],
    },
    {
      provide: APP_PIPE,
      useFactory: () => new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        exceptionFactory: (errors) => {
          // 自定义校验错误消息
          const messages = errors.map((error) => {
            const constraints = error.constraints;
            const firstMessage = Object.values(constraints)[0];
            return `${error.property}: ${firstMessage}`;
          });

          return new BadRequestException(messages.length > 0 ? messages[0] : '校验失败');
        },
      }),
    },
  ],
})
export class AppModule {}
