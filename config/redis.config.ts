import { ConfigService } from '@nestjs/config';
import { RedisOptions } from 'ioredis';

export const createRedisConfig = (configService: ConfigService): RedisOptions => ({
  host: configService.get<string>('redis.host', '127.0.0.1'),
  port: configService.get<number>('redis.port', 6379),
  password: configService.get<string | undefined>('redis.password'),
  db: configService.get<number>('redis.db', 0),
  lazyConnect: true,
  maxRetriesPerRequest: 10,
});