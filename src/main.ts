import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const configService = app.get(ConfigService);

  // 全局前缀
  const globalPrefix = configService.get<string>('GLOBAL_PREFIX', '/api');
  app.setGlobalPrefix(globalPrefix);

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

  const logger = app.get(Logger);
  logger.log(
    `Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
  logger.log(`Swagger documentation: http://localhost:${port}/docs`);
}
bootstrap();
