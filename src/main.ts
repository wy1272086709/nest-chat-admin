import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { loggerMiddleware } from './common/middleware/logger.middleware';
import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const reflector = app.get(Reflector);

  // 全局前缀
  const globalPrefix = configService.get<string>('GLOBAL_PREFIX', '/api');
  app.setGlobalPrefix(globalPrefix);

  // 全局管道
  app.useGlobalPipes(
    new ValidationPipe({
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
  );

  // 全局异常过滤器
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 全局拦截器
  app.useGlobalInterceptors(new TransformInterceptor());

  // 全局JWT认证守卫
  app.useGlobalGuards(new JwtAuthGuard(reflector));

  // 日志中间件
  app.use(loggerMiddleware);

  // Swagger 文档
  const config = new DocumentBuilder()
    .setTitle('Nest Admin API')
    .setDescription('管理后台和聊天API文档')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // 启动端口
  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  console.log(`Application is running on: http://localhost:${port}/${globalPrefix}`);
  console.log(`Swagger documentation: http://localhost:${port}/docs`);
}
bootstrap();